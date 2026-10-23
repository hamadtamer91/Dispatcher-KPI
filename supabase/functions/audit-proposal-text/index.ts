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
//   2. The SAME deterministic Global Maintenance Network rules as
//      audit-proposal (sales tax, EMG-vs-normal rate-sheet, equal hours) are
//      applied in code, but here they MUTATE the parsed line items instead
//      of just flagging a mismatch, since there's no saved proposal for the
//      dispatcher to go edit by hand -- the fixed breakdown IS the output.
//   3. NTE -- if the dispatcher gave a Not-To-Exceed ceiling, the corrected
//      total is checked against it deterministically. Over-NTE is flagged,
//      never auto-cut, since choosing what to trim needs a human call.
//   4. An AI (Gemini) read of whether the (corrected) line items actually
//      match the narrative's scope, PLUS -- using the same AI Learning
//      history (quote_outcomes) generate-proposal pricing calibrates
//      against -- whether this total resembles patterns this client/trade
//      has previously gotten pushed back on.
// A narrative-vs-line-items scope mismatch (e.g. narrative says "repaired
// the door" but a line bills a brand-new door) is never auto-changed --
// that needs a human judgment call about what actually happened on site --
// so it's always returned as a flagged finding with a suggested resolution.

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
              unit_price: { type: 'NUMBER', description: 'The price AS WRITTEN in the text for one unit/hour -- do not calculate or correct anything here, just extract it.' },
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

Pull out the narrative (scope of work, and findings/recommendation if those are written separately), and every billed line item with its kind (labor/part/other), description, role (Technician/Helper/Trip Fee/Assessment Fee/trade name for labor lines), quantity, and the unit price exactly as stated in the text. If a total or subtotal is written, ignore it -- only extract the individual line items.
`.trim()

    const parseRes = await callGeminiWithRetry([{ text: parsePrompt }], parseSchema)
    if (!parseRes.ok) {
      return jsonResponse({ error: await geminiErrorMessage(parseRes) }, parseRes.status === 200 ? 502 : parseRes.status)
    }
    const parseJson = await parseRes.json()
    const parseRawText: string = (parseJson.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
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

    // ---- Stage 2: deterministic GMN fixes, mutating a working copy. ----
    const corrected: CorrectedLineItem[] = originalItems.map((li) => ({ ...li, changed: false, note: null }))
    const fixesApplied: { category: string; message: string }[] = []

    const isGmn = body.entity_id === GMN_ENTITY_ID
    const isEmg = !!body.priority && GMN_EMG_PRIORITIES.has(body.priority)
    const stateKey = (body.state ?? '').trim().toUpperCase()

    const roleMatches = (li: CorrectedLineItem, re: RegExp) => re.test(li.role_name ?? '') || re.test(li.description ?? '')

    if (isGmn) {
      const { data: laborRates } = await supabase
        .from('labor_rates')
        .select('role_name, hourly_cost')
        .eq('entity_id', GMN_ENTITY_ID)
        .eq('active', true)
      const findRate = (roleName: string) =>
        (laborRates ?? []).find((r) => r.role_name.toLowerCase().trim() === roleName.toLowerCase().trim())

      // -- Trip Fee --
      const tripIdx = corrected.findIndex((li) => roleMatches(li, /trip/i))
      if (tripIdx >= 0) {
        const expectedTrip = isEmg ? 112.5 : 75
        if (Math.abs(corrected[tripIdx].unit_price - expectedTrip) > 0.005) {
          const before = corrected[tripIdx].unit_price
          corrected[tripIdx] = { ...corrected[tripIdx], unit_price: expectedTrip, changed: true, note: `Trip Fee corrected from $${before.toFixed(2)} to $${expectedTrip} (${isEmg ? 'EMG' : 'normal'} rate, one trip per job).` }
          fixesApplied.push({ category: 'rate_sheet', message: corrected[tripIdx].note! })
        }
      }

      // -- Trade labor (Technician) + Assessment Fee --
      const tradeName = (body.trade_name ?? '').trim()
      const tradeRate = tradeName ? findRate(isEmg ? `${tradeName} (EMG)` : tradeName) : undefined
      if (tradeRate) {
        const techIdx = corrected.findIndex((li) => li.kind === 'labor' && !roleMatches(li, /helper/i) && !roleMatches(li, /trip/i) && !roleMatches(li, /assess/i))
        if (techIdx >= 0 && Math.abs(corrected[techIdx].unit_price - tradeRate.hourly_cost) > 0.005) {
          const before = corrected[techIdx].unit_price
          corrected[techIdx] = { ...corrected[techIdx], unit_price: tradeRate.hourly_cost, changed: true, note: `${tradeName} labor rate corrected from $${before.toFixed(2)}/hr to $${tradeRate.hourly_cost}/hr (${isEmg ? 'EMG' : 'normal'} rate).` }
          fixesApplied.push({ category: 'rate_sheet', message: corrected[techIdx].note! })
        }
        const assessIdx = corrected.findIndex((li) => roleMatches(li, /assess/i))
        if (assessIdx >= 0 && Math.abs(corrected[assessIdx].unit_price - tradeRate.hourly_cost) > 0.005) {
          const before = corrected[assessIdx].unit_price
          corrected[assessIdx] = { ...corrected[assessIdx], unit_price: tradeRate.hourly_cost, changed: true, note: `Assessment Fee corrected from $${before.toFixed(2)} to $${tradeRate.hourly_cost} (1 hour of ${tradeName}'s labor rate).` }
          fixesApplied.push({ category: 'rate_sheet', message: corrected[assessIdx].note! })
        }
      }

      // -- Helper rate + equal hours --
      const helperRate = findRate(isEmg ? 'Helper (EMG)' : 'Helper')
      const helperIdx = corrected.findIndex((li) => roleMatches(li, /helper/i))
      if (helperIdx >= 0 && helperRate && Math.abs(corrected[helperIdx].unit_price - helperRate.hourly_cost) > 0.005) {
        const before = corrected[helperIdx].unit_price
        corrected[helperIdx] = { ...corrected[helperIdx], unit_price: helperRate.hourly_cost, changed: true, note: `Helper rate corrected from $${before.toFixed(2)}/hr to $${helperRate.hourly_cost}/hr (${isEmg ? 'EMG' : 'normal'} rate).` }
        fixesApplied.push({ category: 'rate_sheet', message: corrected[helperIdx].note! })
      }
      const techIdxForHours = corrected.findIndex((li) => li.kind === 'labor' && !roleMatches(li, /helper/i) && !roleMatches(li, /trip/i) && !roleMatches(li, /assess/i))
      if (helperIdx >= 0 && techIdxForHours >= 0) {
        const techHours = corrected[techIdxForHours].quantity
        const helperHours = corrected[helperIdx].quantity
        if (techHours > 0 && Math.abs(techHours - helperHours) > 0.01) {
          const note = `Helper hours corrected from ${helperHours}hr to ${techHours}hr to match the technician -- GMN's rule is every tech and helper on site gets the same hours.`
          corrected[helperIdx] = { ...corrected[helperIdx], quantity: techHours, changed: true, note: corrected[helperIdx].note ? `${corrected[helperIdx].note} ${note}` : note }
          fixesApplied.push({ category: 'equal_hours', message: note })
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
            if (Math.abs(corrected[taxIdx].unit_price - expectedTax) > 0.02) {
              const before = corrected[taxIdx].unit_price
              corrected[taxIdx] = { ...corrected[taxIdx], quantity: 1, unit_price: expectedTax, changed: true, note: `Sales Tax corrected from $${before.toFixed(2)} to $${expectedTax.toFixed(2)} (${stateKey} ${(rate * 100).toFixed(2)}% avg. combined rate on the $${preTaxSubtotal.toFixed(2)} pre-tax subtotal).` }
              fixesApplied.push({ category: 'tax', message: corrected[taxIdx].note! })
            }
          } else if (expectedTax > 0) {
            const note = `Added a Sales Tax line of $${expectedTax.toFixed(2)} (${stateKey} ${(rate * 100).toFixed(2)}% avg. combined rate) -- O'Reilly/Bob Evans jobs always get sales tax and this proposal was missing it.`
            corrected.push({ kind: 'other', description: `Sales Tax (${stateKey}, ${(rate * 100).toFixed(2)}% avg. combined rate)`, quantity: 1, unit_price: expectedTax, changed: true, note })
            fixesApplied.push({ category: 'tax', message: note })
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
    const subtotalAfter = round2(corrected.reduce((s, li) => s + li.quantity * li.unit_price, 0))

    // ---- Stage 3: NTE -- deterministic, flagged rather than auto-cut
    // since choosing what to trim needs a human call. ----
    const findings: { severity: Severity; category: string; message: string }[] = []
    const nte = body.nte != null && !Number.isNaN(Number(body.nte)) ? Number(body.nte) : null
    if (nte != null && nte > 0 && subtotalAfter > nte + 0.01) {
      findings.push({
        severity: 'high',
        category: 'nte',
        message: `This breakdown totals $${subtotalAfter.toFixed(2)}, which is $${(subtotalAfter - nte).toFixed(2)} over the client's NTE of $${nte.toFixed(2)}. Get NTE approval, or decide what to trim before sending.`,
      })
    }

    // ---- Stage 4: AI Learning context, same cascade generate-proposal
    // calibrates pricing against. ----
    const { contextText: outcomesContext, scopeLabel: outcomesScopeLabel, n: outcomesN } = await fetchOutcomeContext(
      supabase,
      body.client_name ?? null,
      body.trade_name ?? null,
    )

    // ---- Stage 5: AI scope-consistency + pricing-risk check against the
    // corrected items -- flagged only, never auto-changed. ----
    let overallAssessment = ''
    if (corrected.length === 0) {
      findings.push({ severity: 'low', category: 'other', message: 'No line items could be read from the pasted text, so there was nothing to check against the narrative.' })
    } else {
      const lineItemsText = corrected.map((li) => `- [${li.kind}] ${li.description} -- qty ${li.quantity}, bills $${(li.quantity * li.unit_price).toFixed(2)}`).join('\n')
      const scopePrompt = `
You are auditing an already-written maintenance/repair proposal, checking (1) whether the billed line items actually match the scope described in the narrative, and (2) whether the total resembles patterns this client/trade has previously gotten pushed back on. Do not re-judge whether the price is fair in the abstract -- only scope-vs-billing consistency and resemblance to real rejection history.

Work order: ${body.wo || 'n/a'}
Client: ${body.client_name || 'n/a'}
Trade: ${body.trade_name || 'n/a'}
Client's NTE (Not-To-Exceed) for this job: ${nte != null ? `$${nte.toFixed(2)}` : 'not set'}
Current total: $${subtotalAfter.toFixed(2)}

Narrative:
${parsed.narrative_scope || '(none extracted)'}
${parsed.narrative_findings ? `\nFindings:\n${parsed.narrative_findings}` : ''}
${parsed.narrative_recommendation ? `\nRecommendation:\n${parsed.narrative_recommendation}` : ''}

Line items currently billed:
${lineItemsText}

${outcomesContext || 'No labeled approval/rejection history is available yet for this client/trade.'}

Look specifically for:
1. Scope mismatches -- a line item implies a bigger or different job than the narrative describes (the clearest example: narrative says a door was REPAIRED/fixed, but a line item bills a brand-new/replacement door). Category: "scope_mismatch".
2. Parts or labor unrelated to anything in the narrative. Category: "scope_mismatch".
3. Something the narrative implies was done or is needed, with no corresponding line item. Category: "scope_mismatch".
4. Whether this total, or the hours/parts behind it, resembles patterns this client/trade has previously rejected or asked to revise (per the history above). Category: "pricing_risk". Do not flag this just for being close to the NTE -- that's checked separately; only flag a real resemblance to a past rejection pattern.
5. Any other clear inconsistency. Category: "other".

If everything lines up, return an empty findings array and say so in overall_assessment.
`.trim()
      const scopeSchema = {
        type: 'OBJECT',
        properties: {
          findings: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                severity: { type: 'STRING', enum: ['high', 'medium', 'low'] },
                category: { type: 'STRING', enum: ['scope_mismatch', 'pricing_risk', 'other'] },
                message: { type: 'STRING', description: 'What the issue is and a suggested resolution -- this is flagged for a human to decide, never changed automatically.' },
              },
              required: ['severity', 'category', 'message'],
            },
          },
          overall_assessment: { type: 'STRING' },
        },
        required: ['findings', 'overall_assessment'],
      }
      const scopeRes = await callGeminiWithRetry([{ text: scopePrompt }], scopeSchema)
      if (!scopeRes.ok) {
        findings.push({ severity: 'low', category: 'other', message: `Could not run the narrative/pricing scope check -- ${await geminiErrorMessage(scopeRes)}` })
      } else {
        const scopeJson = await scopeRes.json()
        const scopeRawText: string = (scopeJson.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
        try {
          const scopeParsed = JSON.parse(scopeRawText) as { findings?: { severity: Severity; category?: string; message: string }[]; overall_assessment?: string }
          for (const f of scopeParsed.findings ?? []) findings.push({ severity: f.severity, category: f.category ?? 'scope_mismatch', message: f.message })
          overallAssessment = scopeParsed.overall_assessment ?? ''
        } catch {
          findings.push({ severity: 'low', category: 'other', message: 'The AI scope check returned malformed output and was skipped.' })
        }
      }
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
      overall_assessment: overallAssessment,
      ai_learning: { scope_label: outcomesScopeLabel, outcomes_considered: outcomesN },
      checked_at: new Date().toISOString(),
    })
  } catch (e) {
    return jsonResponse({ error: (e as Error).message ?? 'Unexpected error' }, 500)
  }
})

// Same cascade generate-proposal uses to calibrate pricing: client+trade,
// falling back to client-only, then trade-only, then everything, until
// there's enough (4+) labeled history to say something useful.
async function fetchOutcomeContext(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  client: string | null,
  trade: string | null,
): Promise<{ contextText: string; scopeLabel: string; n: number }> {
  type OutcomeRow = { trade: string | null; client: string | null; total_price: number | null; outcome: string; client_feedback: string | null; job_description: string | null }
  const fetchOutcomes = async (filters: { client?: string; trade?: string }): Promise<OutcomeRow[]> => {
    let q = supabase
      .from('quote_outcomes')
      .select('trade, client, total_price, outcome, client_feedback, job_description')
      .order('created_at', { ascending: false })
      .limit(30)
    if (filters.client) q = q.ilike('client', filters.client)
    if (filters.trade) q = q.ilike('trade', filters.trade)
    const { data } = await q
    return data ?? []
  }

  let rows: OutcomeRow[] = []
  let scope: 'client_trade' | 'client' | 'trade' | 'all' = 'all'
  if (client && trade) {
    rows = await fetchOutcomes({ client, trade })
    scope = 'client_trade'
  }
  if (rows.length < 4 && client) {
    rows = await fetchOutcomes({ client })
    scope = 'client'
  }
  if (rows.length < 4 && trade) {
    rows = await fetchOutcomes({ trade })
    scope = 'trade'
  }
  if (rows.length < 4) {
    rows = await fetchOutcomes({})
    scope = 'all'
  }

  const scopeLabel =
    scope === 'client_trade'
      ? `${client} ${trade} jobs specifically`
      : scope === 'client'
        ? `${client} jobs across trades (not enough ${trade ?? 'this trade'}-specific history yet)`
        : scope === 'trade'
          ? `${trade} jobs generally (not enough history for ${client ?? 'this client'} specifically)`
          : 'jobs generally (not enough labeled history yet)'

  if (!rows.length) return { contextText: '', scopeLabel, n: 0 }

  const approved = rows.filter((r) => r.outcome === 'approved')
  const pushedBack = rows.filter((r) => r.outcome === 'rejected' || r.outcome === 'revision_requested')

  const priceStats = (set: OutcomeRow[]) => {
    const priced = set.filter((r) => r.total_price != null && !Number.isNaN(Number(r.total_price)))
    if (!priced.length) return null
    const prices = priced.map((r) => Number(r.total_price))
    return { avg: round2(prices.reduce((s, p) => s + p, 0) / prices.length), min: round2(Math.min(...prices)), max: round2(Math.max(...prices)), n: priced.length }
  }
  const approvedPrice = priceStats(approved)
  const pushedBackPrice = priceStats(pushedBack)

  const quotes = pushedBack
    .filter((r) => r.client_feedback && r.client_feedback.trim())
    .slice(0, 4)
    .map((r) => {
      const label = r.outcome === 'rejected' ? 'rejected' : 'asked to revise/lower'
      const priceNote = r.total_price != null ? `, total was $${r.total_price}` : ''
      return `  - "${r.client_feedback!.trim().slice(0, 160)}" (${label}${priceNote})`
    })
    .join('\n')

  const contextText = `
Historical outcomes for ${scopeLabel}: of ${rows.length} labeled quotes, ${approved.length} approved and ${pushedBack.length} rejected/revision-requested.${
    approvedPrice ? ` Approved totals averaged $${approvedPrice.avg} (range $${approvedPrice.min}-$${approvedPrice.max}, n=${approvedPrice.n}).` : ''
  }${pushedBackPrice ? ` Rejected/revision totals averaged $${pushedBackPrice.avg} (range $${pushedBackPrice.min}-$${pushedBackPrice.max}, n=${pushedBackPrice.n}).` : ''}${
    quotes ? `\nWhat clients said when pushing back:\n${quotes}` : ''
  }`.trim()

  return { contextText, scopeLabel, n: rows.length }
}

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

async function callGeminiWithRetry(userParts: unknown[], responseSchema: unknown): Promise<Response> {
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
          generationConfig: { maxOutputTokens: 4096, responseMimeType: 'application/json', responseSchema },
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
