import { createClient } from 'jsr:@supabase/supabase-js@2'

// "Breakdown" feature: double-checks an EXISTING, already-narrated proposal
// rather than drafting one. Read-only -- it never writes to the proposal or
// its line items. Three kinds of checks, run every time:
//   1. Totals -- do the line items actually add up to the saved subtotal?
//   2. Global Maintenance Network business rules (gated to that entity,
//      same constants/logic as generate-proposal/index.ts): sales tax
//      correctness for O'Reilly/Bob Evans, EMG-vs-normal rate-sheet
//      correctness, and the equal-hours rule.
//   3. An AI (Gemini) read of whether the line items actually match the
//      scope described in the narrative -- e.g. narrative says "repaired
//      the door" but a line item bills a brand-new door. This is the one
//      check that can't be done in code.
// All of this is report-only: findings are returned to the dispatcher to
// act on by hand in the proposal editor, nothing is auto-applied.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash'
const GEMINI_ATTEMPT_TIMEOUT_MS = 110000
const MAX_TRANSIENT_RETRIES = 1

// Kept in sync with the same constants in generate-proposal/index.ts and
// GMN_ENTITY_ID / GMN_EMG_PRIORITIES in src/lib/types.ts.
const GMN_ENTITY_ID = 'ab35027e-3ecc-42b4-9b39-5c6d7e342cd1'
const GMN_EMG_PRIORITIES = new Set(['ASAP', 'EMERGENCY', '4 Hours', '8 Hours', '12 Hours'])

// US state sales tax rates (state base + population-weighted average local
// add-on) -- Tax Foundation, "2026 Sales Tax Rates", as of July 1 2026. A
// state-level average, not an exact per-city lookup. Keyed by the 2-letter
// state abbreviation, matching how `state` is stored on work orders/proposals.
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

// Only O'Reilly and Bob Evans get sales tax -- matched loosely
// (letters/digits only, case-insensitive).
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
type Finding = { severity: Severity; category: string; message: string }

type LineItemRow = {
  id: string
  kind: 'labor' | 'part' | 'other'
  description: string
  quantity: number
  unit_cost: number
  unit_price: number
  labor_rates?: { role_name: string } | null
  parts_price_list?: { name: string } | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401)
    }

    let body: { proposal_id?: string }
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    const proposalId = body.proposal_id
    if (!proposalId) {
      return jsonResponse({ error: 'proposal_id is required' }, 400)
    }

    // Scoped to the caller's own JWT -- RLS decides what they can read.
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: proposal, error: proposalErr } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', proposalId)
      .single()
    if (proposalErr || !proposal) {
      return jsonResponse({ error: 'Proposal not found or not accessible' }, 404)
    }

    if (!proposal.narrative_scope || !proposal.narrative_scope.trim()) {
      return jsonResponse({ error: 'This proposal has no narrative yet -- generate or write one first, then run the breakdown check.' }, 400)
    }

    const { data: workOrder } = await supabase
      .from('work_orders')
      .select('wo, client, trade, city, state')
      .eq('wo', proposal.wo)
      .maybeSingle()

    const { data: rawLineItems } = await supabase
      .from('proposal_line_items')
      .select('id, kind, description, quantity, unit_cost, unit_price, labor_rates(role_name), parts_price_list(name)')
      .eq('proposal_id', proposalId)
      .order('sort_order')
    const lineItems: LineItemRow[] = (rawLineItems as unknown as LineItemRow[]) ?? []

    const findings: Finding[] = []

    // ---- 1. Totals: do the saved line items still add up to the saved
    // subtotal? (Catches a proposal edited by hand after it was last priced.)
    const computedPrice = round2(lineItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0))
    if (lineItems.length && Math.abs(computedPrice - Number(proposal.subtotal_price)) > 0.02) {
      findings.push({
        severity: 'medium',
        category: 'totals',
        message: `The saved subtotal is $${Number(proposal.subtotal_price).toFixed(2)}, but the current line items actually add up to $${computedPrice.toFixed(2)}. The proposal may have been edited since it was last saved/generated -- re-save or regenerate it.`,
      })
    }

    // ---- 2. Global Maintenance Network business rules (gated to that
    // entity -- CBRE/Nexa Fix/etc proposals are unaffected).
    const isGmn = proposal.entity_id === GMN_ENTITY_ID
    const client = proposal.client_name ?? workOrder?.client ?? null
    const isEmg = !!proposal.priority && GMN_EMG_PRIORITIES.has(proposal.priority)

    if (isGmn) {
      // -- Sales tax (O'Reilly / Bob Evans only) --
      const taxLine = lineItems.find((i) => i.description?.startsWith('Sales Tax'))
      const stateKey = (proposal.state ?? workOrder?.state ?? '').trim().toUpperCase()
      if (isTaxableGmnClient(client)) {
        const rate = STATE_SALES_TAX_RATES[stateKey]
        if (!taxLine) {
          if (rate == null) {
            findings.push({
              severity: 'high',
              category: 'tax',
              message: `This is an O'Reilly/Bob Evans job, which should include sales tax, but the State field isn't a recognized 2-letter code ("${proposal.state ?? workOrder?.state ?? '(blank)'}"). Set City/State on the proposal, then regenerate or add the tax line.`,
            })
          } else if (rate > 0) {
            findings.push({
              severity: 'high',
              category: 'tax',
              message: `This is an O'Reilly/Bob Evans job in ${stateKey} (avg. combined rate ${(rate * 100).toFixed(2)}%), but there's no Sales Tax line item on this proposal. Regenerate the draft or add one manually.`,
            })
          }
        } else if (rate != null && rate > 0) {
          const preTax = round2(
            lineItems.filter((i) => i.id !== taxLine.id).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0),
          )
          const expectedTax = round2(preTax * rate)
          const actualTax = round2(Number(taxLine.quantity) * Number(taxLine.unit_price))
          if (Math.abs(expectedTax - actualTax) > 0.02) {
            findings.push({
              severity: 'medium',
              category: 'tax',
              message: `The Sales Tax line is $${actualTax.toFixed(2)}, but ${stateKey}'s ${(rate * 100).toFixed(2)}% avg. combined rate on the $${preTax.toFixed(2)} pre-tax subtotal works out to $${expectedTax.toFixed(2)}. Worth a recheck.`,
            })
          }
        }
        // rate === 0 (e.g. Delaware/Montana/NH/Oregon) -- correctly no tax line.
      } else if (taxLine) {
        findings.push({
          severity: 'low',
          category: 'tax',
          message: `There's a Sales Tax line item on this proposal, but for Global Maintenance Network tax only applies to O'Reilly/Bob Evans jobs. Double-check the client on this job ("${client ?? '(not set)'}") is actually one of those two.`,
        })
      }

      // -- EMG vs. normal rate-sheet correctness --
      const tradeName = proposal.trade_name ?? workOrder?.trade ?? null
      if (tradeName && tradeName.trim()) {
        const { data: laborRates } = await supabase
          .from('labor_rates')
          .select('role_name, hourly_cost')
          .eq('entity_id', GMN_ENTITY_ID)
          .eq('active', true)
        const findRate = (roleName: string) =>
          (laborRates ?? []).find((r) => r.role_name.toLowerCase().trim() === roleName.toLowerCase().trim())
        const tradeRate = findRate(isEmg ? `${tradeName.trim()} (EMG)` : tradeName.trim())
        const helperRate = findRate(isEmg ? 'Helper (EMG)' : 'Helper')
        const expectedTrip = isEmg ? 112.5 : 75
        const priorityLabel = proposal.priority ?? '(none set -- defaults to normal rate)'

        if (tradeRate) {
          if (proposal.technician_rate != null && Math.abs(Number(proposal.technician_rate) - tradeRate.hourly_cost) > 0.005) {
            findings.push({
              severity: 'medium',
              category: 'rate_sheet',
              message: `Priority "${priorityLabel}" means ${isEmg ? 'EMG' : 'normal'} rates for ${tradeName}. Technician Rate should be $${tradeRate.hourly_cost}/hr, but it's set to $${Number(proposal.technician_rate).toFixed(2)}/hr.`,
            })
          }
          if (proposal.assessment_fee != null && Math.abs(Number(proposal.assessment_fee) - tradeRate.hourly_cost) > 0.005) {
            findings.push({
              severity: 'low',
              category: 'rate_sheet',
              message: `Assessment Fee should equal 1 hour of ${tradeName}'s labor rate ($${tradeRate.hourly_cost}), but it's set to $${Number(proposal.assessment_fee).toFixed(2)}.`,
            })
          }
        }
        if (helperRate && proposal.helper_rate != null && Math.abs(Number(proposal.helper_rate) - helperRate.hourly_cost) > 0.005) {
          findings.push({
            severity: 'low',
            category: 'rate_sheet',
            message: `Helper Rate should be $${helperRate.hourly_cost}/hr at ${isEmg ? 'EMG' : 'normal'} rates, but it's set to $${Number(proposal.helper_rate).toFixed(2)}/hr.`,
          })
        }
        if (proposal.trip_fee != null && Math.abs(Number(proposal.trip_fee) - expectedTrip) > 0.005) {
          findings.push({
            severity: 'medium',
            category: 'rate_sheet',
            message: `Priority "${priorityLabel}" means ${isEmg ? 'EMG' : 'normal'} rates, so Trip Fee should be $${expectedTrip}, but it's set to $${Number(proposal.trip_fee).toFixed(2)}.`,
          })
        }
      }

      // -- Equal hours for everyone on site --
      const closeTo = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.005
      const hoursByRole = new Map<string, number>()
      for (const li of lineItems) {
        if (li.kind !== 'labor') continue
        const roleName =
          li.labor_rates?.role_name ??
          (closeTo(li.unit_cost, proposal.technician_rate) ? 'Technician' : closeTo(li.unit_cost, proposal.helper_rate) ? 'Helper' : 'Labor')
        hoursByRole.set(roleName, (hoursByRole.get(roleName) ?? 0) + Number(li.quantity))
      }
      const techHours = hoursByRole.get('Technician') ?? 0
      const helperHours = hoursByRole.get('Helper') ?? 0
      if (techHours > 0 && helperHours > 0 && Math.abs(techHours - helperHours) > 0.01) {
        findings.push({
          severity: helperHours < techHours ? 'medium' : 'low',
          category: 'equal_hours',
          message: `Technician is billed ${techHours}hr but Helper is billed ${helperHours}hr. GMN's rule is every tech and helper on site gets the same hours -- a helper should never get fewer hours than the tech.`,
        })
      }
    }

    // ---- 3. AI check: does the narrative actually match what's being
    // billed? (e.g. narrative says "repaired the door" but a line item
    // bills a brand-new door.) Applies to any entity, not just GMN.
    let overallAssessment = ''
    if (!GEMINI_API_KEY) {
      findings.push({
        severity: 'low',
        category: 'other',
        message: 'GEMINI_API_KEY is not configured for this project, so the narrative-vs-line-items scope check could not run. Only the deterministic pricing/tax checks above ran.',
      })
    } else if (lineItems.length === 0) {
      findings.push({ severity: 'low', category: 'other', message: 'This proposal has no line items yet, so there is nothing to compare against the narrative.' })
    } else {
      const lineItemsText = lineItems
        .map((li) => {
          const label = li.labor_rates?.role_name ?? li.parts_price_list?.name ?? li.description
          return `- [${li.kind}] ${li.description}${label && label !== li.description ? ` (${label})` : ''} -- qty ${li.quantity}, bills $${(Number(li.quantity) * Number(li.unit_price)).toFixed(2)}`
        })
        .join('\n')

      const promptText = `
You are auditing an ALREADY-WRITTEN maintenance/repair proposal before it goes out, specifically checking whether what's being billed on the line items actually matches the scope described in the narrative. You are not drafting anything and not re-pricing anything -- only flagging mismatches for a human dispatcher to review.

Work order: ${proposal.wo}
Client: ${client ?? 'Unknown'}
Trade: ${proposal.trade_name ?? workOrder?.trade ?? 'Unknown'}
Location: ${[proposal.city ?? workOrder?.city, proposal.state ?? workOrder?.state].filter(Boolean).join(', ') || 'Unknown'}
Priority: ${proposal.priority ?? '(none set)'}

Narrative (scope of work as written for the client):
${proposal.narrative_scope}

${proposal.narrative_findings ? `Findings on site:\n${proposal.narrative_findings}\n` : ''}${proposal.narrative_recommendation ? `Recommendation:\n${proposal.narrative_recommendation}\n` : ''}${proposal.technician_notes ? `Technician's raw notes:\n${proposal.technician_notes}\n` : ''}
Line items currently billed:
${lineItemsText}

Look specifically for:
1. Scope mismatches -- a line item implies a bigger or different job than the narrative describes (the clearest example: narrative says a door was REPAIRED/fixed, but a line item bills a brand-new/replacement door; or narrative describes a simple fix but parts/labor reflect a full replacement).
2. Parts or labor that don't seem related to anything in the narrative at all.
3. Something the narrative implies was done or is needed, with no corresponding line item (missing charges).
4. Any other clear inconsistency between what's described and what's billed.

Do not flag normal incidentals (disposal, minor hardware, trip/assessment fees, sales tax) as mismatches. Do not re-judge whether the price is fair -- only scope-vs-billing consistency. If everything lines up, return an empty findings array and say so in overall_assessment.
`.trim()

      const responseSchema = {
        type: 'OBJECT',
        properties: {
          findings: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                severity: { type: 'STRING', enum: ['high', 'medium', 'low'] },
                message: { type: 'STRING' },
              },
              required: ['severity', 'message'],
            },
          },
          overall_assessment: {
            type: 'STRING',
            description: 'One or two sentences on whether the narrative and the billed line items agree overall.',
          },
        },
        required: ['findings', 'overall_assessment'],
      }

      const geminiRes = await callGeminiWithRetry([{ text: promptText }], responseSchema)

      if (!geminiRes.ok) {
        const label = geminiRes.status === 429 ? "Gemini's rate limit is maxed out" : geminiRes.status === 503 ? "Gemini's servers are temporarily overloaded" : geminiRes.status === 504 ? 'the AI took too long to respond' : `the AI call failed (${geminiRes.status})`
        findings.push({ severity: 'low', category: 'other', message: `Could not run the narrative-vs-line-items scope check -- ${label}. The deterministic pricing/tax checks above still ran. Try again in a bit.` })
      } else {
        const geminiJson = await geminiRes.json()
        const rawText: string = (geminiJson.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
        try {
          const parsed = JSON.parse(rawText) as { findings?: { severity: Severity; message: string }[]; overall_assessment?: string }
          for (const f of parsed.findings ?? []) {
            findings.push({ severity: f.severity, category: 'scope_mismatch', message: f.message })
          }
          overallAssessment = parsed.overall_assessment ?? ''
        } catch {
          findings.push({ severity: 'low', category: 'other', message: 'The AI scope check returned malformed output and was skipped. The deterministic pricing/tax checks above still ran.' })
        }
      }
    }

    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => order[a.severity] - order[b.severity])

    return jsonResponse({
      findings,
      overall_assessment: overallAssessment,
      checked_at: new Date().toISOString(),
    })
  } catch (e) {
    return jsonResponse({ error: (e as Error).message ?? 'Unexpected error' }, 500)
  }
})

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
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY!,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: {
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            responseSchema,
          },
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
