import { createClient } from 'jsr:@supabase/supabase-js@2'

// Companion to audit-proposal, for a proposal that was never entered into
// this app -- the dispatcher pastes the narrative + pricing breakdown as
// plain text instead of picking a saved proposal. Nothing is read from or
// written to the proposals/proposal_line_items tables; this is a scratch
// check-and-fix tool.
//
// Stages:
//   1. Gemini parses the pasted text into a narrative + structured line
//      items, extracting the prices exactly as written (no corrections yet
//      -- that would mean trusting the model with arithmetic, which this
//      app never does).
//   2. Deterministic fixes, applied in code (never trusted to the AI),
//      MUTATING the parsed line items instead of just flagging a mismatch
//      -- there's no saved proposal for the dispatcher to go edit by hand,
//      so the fixed breakdown IS the output. Two kinds:
//        - Labor rate vs. this job's OWN entity price list (Technician,
//          Assessment Fee, Helper) -- works for any entity, as long as that
//          entity has its price list filled in.
//        - Global Maintenance Network's own contract terms (flat Trip Fee,
//          every tech/helper gets equal hours, O'Reilly/Bob Evans sales
//          tax) -- GMN-only, same as audit-proposal.
//      If the dispatcher gave a Not-To-Exceed ceiling, a fix is only
//      auto-applied when the result stays at-or-under it; a fix that would
//      cross the NTE is left unapplied and flagged instead, since crossing
//      it needs a human call (get approval, or trim something else), never
//      a silent auto-fix. A fix that only lowers the total always goes
//      through.
//   3. NTE status -- if, even after that, the total is still over the
//      client's NTE (it was already over before any fixing, say), that's
//      flagged too.
// This function returns as soon as those three stages are done -- it used
// to also run a 2nd AI pass here (checking the corrected items against the
// narrative, the parts price list, and past outcomes), but that made every
// check wait for two full AI calls before showing anything. That pass now
// lives in its own function, check-breakdown-scope, which the frontend
// calls right after this one returns, so the corrected breakdown shows up
// as soon as this (faster) pass finishes and the slower judgment-call
// findings fill in a few seconds later.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash'
const GEMINI_ATTEMPT_TIMEOUT_MS = 110000
const MAX_TRANSIENT_RETRIES = 1

const GMN_ENTITY_ID = 'ab35027e-3ecc-42b4-9b39-5c6d7e342cd1'
const GMN_EMG_PRIORITIES = new Set(['ASAP', 'EMERGENCY', '4 Hours', '8 Hours', '12 Hours'])

const STATE_SALES_TAX_RATES: Record<string, number> = {
  AL: 0.0946, AK: 0.0182, AZ: 0.0854, AR: 0.0948, CA: 0.0903, CO: 0.0789,
  CT: 0.0635, DE: 0, DC: 0.06, FL: 0.0698, GA: 0.0756, HI: 0.045,
  ID: 0.0603, IL: 0.0898, IN: 0.07, IA: 0.0694, KS: 0.0871, KY: 0.06,
  LA: 0.1013, ME: 0.055, MD: 0.06, MA: 0.0625, MI: 0.06, MN: 0.0814,
  MS: 0.0706, MO: 0.0844, MT: 0, NE: 0.0698, NV: 0.0824, NH: 0,
  NJ: 0.066, NM: 0.0768, NY: 0.0854, NC: 0.071, ND: 0.0709, OH: 0.0729,
  OK: 0.0906, OR: 0, PA: 0.0634, RI: 0.07, SC: 0.0749, SD: 0.0611,
  TN: 0.0961, TX: 0.082, UT: 0.0742, VT: 0.0643, VA: 0.0577, WA: 0.0957,
  WV: 0.066, WI: 0.0572, WY: 0.0539,
}

function isTaxableGmnClient(clientName: string | null | undefined): boolean {
  const key = (clientName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return key.includes('oreilly') || key.includes('bobevans')
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Severity = 'high' | 'medium' | 'low'
type ParsedLineItem = { kind: 'labor' | 'part' | 'other'; description: string; role_name?: string; quantity: number; unit_price: number }
type CorrectedLineItem = ParsedLineItem & { changed: boolean; note: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  try {
    if (!GEMINI_API_KEY) {
      return jsonResponse({ error: 'GEMINI_API_KEY is not configured for this project. Ask a Super Admin to set it as an Edge Function secret.' }, 500)
    }
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401)

    let body: {
      entity_id?: string
      wo?: string
      client_name?: string
      trade_name?: string
      city?: string
      state?: string
      priority?: string
      nte?: number | null
      proposal_text?: string
    }
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    const proposalText = (body.proposal_text ?? '').trim()
    if (!proposalText) {
      return jsonResponse({ error: 'Paste the proposal text first.' }, 400)
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    // ---- Stage 1: parse the free text into a narrative + structured line
    // items, extracting prices exactly as written. ----
    const parseSchema = {
      type: 'OBJECT',
      properties: {
        narrative_scope: { type: 'STRING', description: 'The scope-of-work narrative as written. If the text has no clearly separate narrative, put the descriptive text here.' },
        narrative_findings: { type: 'STRING', description: 'Findings/diagnosis section, if the text has one separate from the scope. Empty string if none.' },
        narrative_recommendation: { type: 'STRING', description: 'Recommendation section, if separate. Empty string if none.' },
        line_items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              kind: { type: 'STRING', enum: ['labor', 'part', 'other'] },
              description: { type: 'STRING' },
              role_name: {
                type: 'STRING',
                description: 'Labor lines only: "Technician", "Helper", "Trip Fee", or "Assessment Fee" if that\'s what the line is, else the stated trade (e.g. "Plumber"). Empty for parts/other.',
              },
              quantity: { type: 'NUMBER', description: 'Hours for labor, count for parts/other. Default 1 if not stated.' },
              unit_price: {
                type: 'NUMBER',
                description:
                  'The price for ONE unit/hour. If the text gives a single dollar figure next to a quantity greater than 1 (e.g. "Breakers x2: $115.98"), that figure is the TOTAL for all of them -- divide by the quantity to get this per-unit price (so "x2: $115.98" means unit_price 57.99, not 115.98). If the text already states a per-unit/per-hour rate (e.g. "$95/hr", "$57.99 each"), use that number directly. Do not otherwise calculate or correct anything, just extract/derive this one number.',
              },
            },
            required: ['kind', 'description', 'quantity', 'unit_price'],
          },
        },
      },
      required: ['narrative_scope', 'line_items'],
    }

    const parsePrompt = `
Extract the structure of this already-written maintenance/repair proposal exactly as given -- do not fix, recalculate, or second-guess anything at this step, just pull out what's there.

Work order: ${body.wo || 'n/a'}
Client: ${body.client_name || 'n/a'}
Trade: ${body.trade_name || 'n/a'}
Location: ${[body.city, body.state].filter(Boolean).join(', ') || 'n/a'}
Priority: ${body.priority || 'n/a'}

Pasted proposal text:
"""
${proposalText}
"""

Pull out the narrative (scope of work, and findings/recommendation if those are written separately), and every billed line item with its kind (labor/part/other), description, role (Technician/Helper/Trip Fee/Assessment Fee/trade name for labor lines), quantity, and the unit price. Watch for a common shorthand: "Description xN: $amount" means $amount is the TOTAL for all N units/hours, not the price of one -- in that case the unit price is $amount divided by N. If a total or subtotal is written at the end of the proposal, ignore it -- only extract the individual line items.
`.trim()

    // 16384 (same headroom generate-proposal uses) -- a long narrative plus
    // many line items echoed back as structured JSON can otherwise run
    // past the default limit and come back cut off mid-response.
    const parseRes = await callGeminiWithRetry([{ text: parsePrompt }], parseSchema, 16384)
    if (!parseRes.ok) {
      return jsonResponse({ error: await geminiErrorMessage(parseRes) }, parseRes.status === 200 ? 502 : parseRes.status)
    }
    const parseJson = await parseRes.json()
    const parseCandidate = parseJson.candidates?.[0]
    const parseRawText: string = (parseCandidate?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
    // A response cut off at the token limit lands here as non-empty but
    // truncated JSON -- catch it by finishReason before attempting to
    // parse, rather than letting it surface as a generic "malformed" error.
    if (parseCandidate?.finishReason === 'MAX_TOKENS') {
      return jsonResponse({ error: 'That proposal produced too much text and got cut off while being read. Try pasting a shorter excerpt, or split it into smaller checks.' }, 502)
    }
    if (!parseRawText) {
      return jsonResponse({ error: 'The AI could not read the pasted text. Try pasting it again, or check it has at least a narrative and a few line items.' }, 502)
    }
    let parsed: { narrative_scope: string; narrative_findings?: string; narrative_recommendation?: string; line_items: ParsedLineItem[] }
    try {
      parsed = JSON.parse(parseRawText)
    } catch {
      return jsonResponse({ error: 'The AI returned malformed output while parsing the pasted text. Try again.' }, 502)
    }
    const originalItems: ParsedLineItem[] = (parsed.line_items ?? []).map((li) => ({
      kind: li.kind,
      description: li.description,
      role_name: li.role_name || undefined,
      quantity: Number(li.quantity) || 0,
      unit_price: Number(li.unit_price) || 0,
    }))

    // ---- Stage 2: deterministic GMN fixes, mutating a working copy. A fix
    // that would INCREASE the total is checked against the client's NTE
    // first -- if applying it would push the breakdown over that ceiling,
    // it's left unapplied and flagged instead, since crossing the NTE needs
    // a human decision (get approval, or find something else to trim), not
    // a silent auto-fix. A fix that only lowers the total (removing tax
    // that doesn't apply, correcting an over-charged rate) always goes
    // through -- it can only help stay under NTE, never push it over. ----
    const corrected: CorrectedLineItem[] = originalItems.map((li) => ({ ...li, changed: false, note: null }))
    const fixesApplied: { category: string; message: string }[] = []
    const findings: { severity: Severity; category: string; message: string }[] = []
    const nte = body.nte != null && !Number.isNaN(Number(body.nte)) ? Number(body.nte) : null

    const isGmn = body.entity_id === GMN_ENTITY_ID
    const isEmg = !!body.priority && GMN_EMG_PRIORITIES.has(body.priority)
    const stateKey = (body.state ?? '').trim().toUpperCase()

    const roleMatches = (li: CorrectedLineItem, re: RegExp) => re.test(li.role_name ?? '') || re.test(li.description ?? '')
    const currentTotal = () => round2(corrected.reduce((s, li) => s + li.quantity * li.unit_price, 0))
    // A delta that lowers (or doesn't change) the total always fits. A
    // delta that raises it only fits if the result stays at-or-under NTE
    // (or there's no NTE set to check against).
    const fitsUnderNte = (delta: number) => {
      if (nte == null || nte <= 0 || delta <= 0.005) return true
      return round2(currentTotal() + delta) <= nte + 0.01
    }
    const withheldForNte = (message: string) => {
      findings.push({ severity: 'high', category: 'nte', message })
    }

    // Index lookups shared by both the generic labor-rate check below and
    // GMN's own Trip Fee / equal-hours rules further down.
    const tradeName = (body.trade_name ?? '').trim()
    const techIdx = corrected.findIndex((li) => li.kind === 'labor' && !roleMatches(li, /helper/i) && !roleMatches(li, /trip/i) && !roleMatches(li, /assess/i))
    const assessIdx = corrected.findIndex((li) => roleMatches(li, /assess/i))
    const helperIdx = corrected.findIndex((li) => roleMatches(li, /helper/i))
    const tripIdx = corrected.findIndex((li) => roleMatches(li, /trip/i))

    // -- Labor rates vs. this job's OWN entity price list (Technician,
    // Assessment Fee, Helper) -- works for any entity that has its price
    // list filled in, not just GMN. --
    if (body.entity_id) {
      const { data: laborRates } = await supabase
        .from('labor_rates')
        .select('role_name, hourly_cost')
        .eq('entity_id', body.entity_id)
        .eq('active', true)
      const findRate = (roleName: string) =>
        (laborRates ?? []).find((r) => r.role_name.toLowerCase().trim() === roleName.toLowerCase().trim())

      const tradeRate = tradeName ? findRate(isEmg ? `${tradeName} (EMG)` : tradeName) : undefined
      if (tradeRate) {
        if (techIdx >= 0) {
          const before = corrected[techIdx].unit_price
          if (Math.abs(before - tradeRate.hourly_cost) > 0.005) {
            const delta = round2(corrected[techIdx].quantity * (tradeRate.hourly_cost - before))
            if (fitsUnderNte(delta)) {
              corrected[techIdx] = { ...corrected[techIdx], unit_price: tradeRate.hourly_cost, changed: true, note: `${tradeName} labor rate corrected from $${before.toFixed(2)}/hr to $${tradeRate.hourly_cost}/hr (${isEmg ? 'EMG' : 'normal'} rate, from the price list).` }
              fixesApplied.push({ category: 'rate_sheet', message: corrected[techIdx].note! })
            } else {
              withheldForNte(`${tradeName} labor should be corrected from $${before.toFixed(2)}/hr to $${tradeRate.hourly_cost}/hr (${isEmg ? 'EMG' : 'normal'} rate, from the price list), but that would push the total over the client's NTE of $${nte!.toFixed(2)} -- left as pasted. Get NTE approval, then run the check again to apply it.`)
            }
          }
        }
        if (assessIdx >= 0) {
          const before = corrected[assessIdx].unit_price
          if (Math.abs(before - tradeRate.hourly_cost) > 0.005) {
            const delta = round2(corrected[assessIdx].quantity * (tradeRate.hourly_cost - before))
            if (fitsUnderNte(delta)) {
              corrected[assessIdx] = { ...corrected[assessIdx], unit_price: tradeRate.hourly_cost, changed: true, note: `Assessment Fee corrected from $${before.toFixed(2)} to $${tradeRate.hourly_cost} (1 hour of ${tradeName}'s labor rate).` }
              fixesApplied.push({ category: 'rate_sheet', message: corrected[assessIdx].note! })
            } else {
              withheldForNte(`Assessment Fee should be corrected from $${before.toFixed(2)} to $${tradeRate.hourly_cost} (1 hour of ${tradeName}'s labor rate), but that would push the total over the client's NTE of $${nte!.toFixed(2)} -- left as pasted. Get NTE approval, then run the check again to apply it.`)
            }
          }
        }
      }

      const helperRate = findRate(isEmg ? 'Helper (EMG)' : 'Helper')
      if (helperIdx >= 0 && helperRate) {
        const before = corrected[helperIdx].unit_price
        if (Math.abs(before - helperRate.hourly_cost) > 0.005) {
          const delta = round2(corrected[helperIdx].quantity * (helperRate.hourly_cost - before))
          if (fitsUnderNte(delta)) {
            corrected[helperIdx] = { ...corrected[helperIdx], unit_price: helperRate.hourly_cost, changed: true, note: `Helper rate corrected from $${before.toFixed(2)}/hr to $${helperRate.hourly_cost}/hr (${isEmg ? 'EMG' : 'normal'} rate, from the price list).` }
            fixesApplied.push({ category: 'rate_sheet', message: corrected[helperIdx].note! })
          } else {
            withheldForNte(`Helper rate should be corrected from $${before.toFixed(2)}/hr to $${helperRate.hourly_cost}/hr (${isEmg ? 'EMG' : 'normal'} rate, from the price list), but that would push the total over the client's NTE of $${nte!.toFixed(2)} -- left as pasted. Get NTE approval, then run the check again to apply it.`)
          }
        }
      }
    }

    // -- Global Maintenance Network's own contract terms: flat Trip Fee,
    // equal tech/helper hours, and O'Reilly/Bob Evans sales tax. These are
    // GMN-specific business rules, not price-list lookups, so they stay
    // gated to GMN jobs only. --
    if (isGmn) {
      // -- Trip Fee --
      if (tripIdx >= 0) {
        const expectedTrip = isEmg ? 112.5 : 75
        const before = corrected[tripIdx].unit_price
        if (Math.abs(before - expectedTrip) > 0.005) {
          const delta = round2(corrected[tripIdx].quantity * (expectedTrip - before))
          if (fitsUnderNte(delta)) {
            corrected[tripIdx] = { ...corrected[tripIdx], unit_price: expectedTrip, changed: true, note: `Trip Fee corrected from $${before.toFixed(2)} to $${expectedTrip} (${isEmg ? 'EMG' : 'normal'} rate, one trip per job).` }
            fixesApplied.push({ category: 'rate_sheet', message: corrected[tripIdx].note! })
          } else {
            withheldForNte(`Trip Fee should be corrected from $${before.toFixed(2)} to $${expectedTrip} (${isEmg ? 'EMG' : 'normal'} rate), but that would push the total over the client's NTE of $${nte!.toFixed(2)} -- left as pasted. Get NTE approval, then run the check again to apply it.`)
          }
        }
      }

      // -- Equal hours --
      if (helperIdx >= 0 && techIdx >= 0) {
        const techHours = corrected[techIdx].quantity
        const helperHours = corrected[helperIdx].quantity
        if (techHours > 0 && Math.abs(techHours - helperHours) > 0.01) {
          const delta = round2((techHours - helperHours) * corrected[helperIdx].unit_price)
          if (fitsUnderNte(delta)) {
            const note = `Helper hours corrected from ${helperHours}hr to ${techHours}hr to match the technician -- GMN's rule is every tech and helper on site gets the same hours.`
            corrected[helperIdx] = { ...corrected[helperIdx], quantity: techHours, changed: true, note: corrected[helperIdx].note ? `${corrected[helperIdx].note} ${note}` : note }
            fixesApplied.push({ category: 'equal_hours', message: note })
          } else {
            withheldForNte(`Helper hours should be corrected from ${helperHours}hr to ${techHours}hr to match the technician, but that would push the total over the client's NTE of $${nte!.toFixed(2)} -- left as pasted. Get NTE approval, then run the check again to apply it.`)
          }
        }
      }

      // -- Sales tax (O'Reilly / Bob Evans only) --
      const taxIdx = corrected.findIndex((li) => /sales tax/i.test(li.description ?? ''))
      const taxable = isTaxableGmnClient(body.client_name)
      const preTaxSubtotal = round2(
        corrected.filter((_, i) => i !== taxIdx).reduce((s, li) => s + li.quantity * li.unit_price, 0),
      )
      if (taxable) {
        const rate = STATE_SALES_TAX_RATES[stateKey]
        if (rate != null && rate > 0) {
          const expectedTax = round2(preTaxSubtotal * rate)
          if (taxIdx >= 0) {
            const before = corrected[taxIdx].unit_price
            if (Math.abs(before - expectedTax) > 0.02) {
              const delta = round2(expectedTax - before)
              if (fitsUnderNte(delta)) {
                corrected[taxIdx] = { ...corrected[taxIdx], quantity: 1, unit_price: expectedTax, changed: true, note: `Sales Tax corrected from $${before.toFixed(2)} to $${expectedTax.toFixed(2)} (${stateKey} ${(rate * 100).toFixed(2)}% avg. combined rate on the $${preTaxSubtotal.toFixed(2)} pre-tax subtotal).` }
                fixesApplied.push({ category: 'tax', message: corrected[taxIdx].note! })
              } else {
                withheldForNte(`Sales Tax should be corrected from $${before.toFixed(2)} to $${expectedTax.toFixed(2)} (${stateKey} ${(rate * 100).toFixed(2)}% avg. combined rate), but that would push the total over the client's NTE of $${nte!.toFixed(2)} -- left as pasted. Get NTE approval, then run the check again to apply it.`)
              }
            }
          } else if (expectedTax > 0) {
            if (fitsUnderNte(expectedTax)) {
              const note = `Added a Sales Tax line of $${expectedTax.toFixed(2)} (${stateKey} ${(rate * 100).toFixed(2)}% avg. combined rate) -- O'Reilly/Bob Evans jobs always get sales tax and this proposal was missing it.`
              corrected.push({ kind: 'other', description: `Sales Tax (${stateKey}, ${(rate * 100).toFixed(2)}% avg. combined rate)`, quantity: 1, unit_price: expectedTax, changed: true, note })
              fixesApplied.push({ category: 'tax', message: note })
            } else {
              withheldForNte(`A Sales Tax line of $${expectedTax.toFixed(2)} (${stateKey} ${(rate * 100).toFixed(2)}% avg. combined rate) should be added -- O'Reilly/Bob Evans jobs always get sales tax -- but that would push the total over the client's NTE of $${nte!.toFixed(2)}. Left off for now; get NTE approval, then run the check again to add it.`)
            }
          }
        } else if (rate == null) {
          fixesApplied.push({ category: 'tax', message: `Couldn't verify sales tax -- "${body.state || '(blank)'}" isn't a recognized 2-letter state code. Set a valid State and check again.` })
        }
        // rate === 0 -- correctly no tax (DE/MT/NH/OR).
      } else if (taxIdx >= 0) {
        const removed = corrected[taxIdx]
        corrected.splice(taxIdx, 1)
        const note = `Removed the Sales Tax line (was $${removed.unit_price.toFixed(2)}) -- for Global Maintenance Network, tax only applies to O'Reilly/Bob Evans jobs, and the client here is "${body.client_name || '(not set)'}".`
        fixesApplied.push({ category: 'tax', message: note })
      }
    }

    const subtotalBefore = round2(originalItems.reduce((s, li) => s + li.quantity * li.unit_price, 0))
    const subtotalAfter = currentTotal()

    // ---- Stage 3: final NTE status. The fixes above already stop short of
    // crossing the NTE on their own (see fitsUnderNte), so this only fires
    // when the breakdown was already over NTE before any fixing, or still
    // is after removing whatever could safely be removed (e.g. tax that
    // doesn't apply here). ----
    if (nte != null && nte > 0 && subtotalAfter > nte + 0.01) {
      findings.push({
        severity: 'high',
        category: 'nte',
        message: `This breakdown totals $${subtotalAfter.toFixed(2)}, which is $${(subtotalAfter - nte).toFixed(2)} over the client's NTE of $${nte.toFixed(2)}. Get NTE approval, or decide what to trim before sending.`,
      })
    }

    // ---- Done -- hand back the corrected breakdown right away. (See the
    // file-top comment: the AI scope/parts-pricing/history check that used
    // to run here as a further stage now lives in check-breakdown-scope.) ----
    if (corrected.length === 0) {
      findings.push({ severity: 'low', category: 'other', message: 'No line items could be read from the pasted text, so there was nothing to check against the narrative.' })
    }

    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => order[a.severity] - order[b.severity])

    return jsonResponse({
      narrative_scope: parsed.narrative_scope ?? '',
      narrative_findings: parsed.narrative_findings ?? '',
      narrative_recommendation: parsed.narrative_recommendation ?? '',
      original_line_items: originalItems,
      corrected_line_items: corrected,
      fixes_applied: fixesApplied,
      scope_findings: findings,
      subtotal_before: subtotalBefore,
      subtotal_after: subtotalAfter,
      checked_at: new Date().toISOString(),
    })
  } catch (e) {
    return jsonResponse({ error: (e as Error).message ?? 'Unexpected error' }, 500)
  }
})

async function geminiErrorMessage(res: Response): Promise<string> {
  if (res.status === 429) return "Gemini's rate limit is maxed out. Wait about a minute before trying again."
  if (res.status === 503) return "Gemini's servers are temporarily overloaded. Try again shortly."
  if (res.status === 504) return 'The AI took too long to respond. Try again.'
  try {
    return `AI call failed (${res.status}): ${await res.text()}`
  } catch {
    return `AI call failed (${res.status})`
  }
}

async function callGeminiWithRetry(userParts: unknown[], responseSchema: unknown, maxOutputTokens = 4096): Promise<Response> {
  let transientRetries = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GEMINI_ATTEMPT_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: { maxOutputTokens, responseMimeType: 'application/json', responseSchema },
        }),
        signal: controller.signal,
      })
    } catch {
      return new Response(null, { status: 504 })
    } finally {
      clearTimeout(timer)
    }

    if (res.ok) return res
    if (transientRetries >= MAX_TRANSIENT_RETRIES) return res

    if (res.status === 503) {
      transientRetries++
      await res.body?.cancel()
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (res.status === 429) {
      transientRetries++
      let delayMs = 8000
      try {
        const errBody = await res.clone().json()
        const retryInfo = (errBody?.error?.details ?? []).find((d: { ['@type']?: string }) => d['@type']?.includes('RetryInfo'))
        const raw = retryInfo?.retryDelay as string | undefined
        const secs = raw ? parseFloat(raw) : NaN
        if (!Number.isNaN(secs)) delayMs = Math.min(Math.ceil(secs * 1000) + 500, 10000)
      } catch {
        // use default delayMs
      }
      await res.body?.cancel()
      await new Promise((r) => setTimeout(r, delayMs))
      continue
    }
    return res
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
