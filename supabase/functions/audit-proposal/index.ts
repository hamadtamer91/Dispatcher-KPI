import { createClient } from 'jsr:@supabase/supabase-js@2'

// "Breakdown" feature: double-checks an EXISTING, already-narrated proposal
// rather than drafting one. Read-only -- it never writes to the proposal or
// its line items. Checks run every time:
//   1. Totals -- do the line items actually add up to the saved subtotal?
//   2. NTE -- does the current total exceed the client's Not-To-Exceed
//      ceiling (proposal.nte)? Deterministic, same as the pricing math.
//   3. Global Maintenance Network business rules (gated to that entity,
//      same constants/logic as generate-proposal/index.ts): sales tax
//      correctness for O'Reilly/Bob Evans, EMG-vs-normal rate-sheet
//      correctness, and the equal-hours rule.
//   4. An AI (Gemini) read of whether the line items actually match the
//      scope described in the narrative -- e.g. narrative says "repaired
//      the door" but a line item bills a brand-new door -- PLUS, using the
//      same AI Learning history (quote_outcomes) generate-proposal pricing
//      calibrates against, whether this total looks like it'll face the
//      kind of pushback this client/trade has a track record of giving.
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
    const client = proposal.client_name ?? workOrder?.client ?? null
    const tradeName = proposal.trade_name ?? workOrder?.trade ?? null

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
    const currentTotal = lineItems.length ? computedPrice : Number(proposal.subtotal_price)

    // ---- 2. NTE: does the current total exceed the client's Not-To-Exceed
    // ceiling? Deterministic -- same reasoning as the pricing math below.
    if (proposal.nte != null && Number(proposal.nte) > 0 && currentTotal > Number(proposal.nte) + 0.01) {
      findings.push({
        severity: 'high',
        category: 'nte',
        message: `This proposal totals $${currentTotal.toFixed(2)}, which is $${(currentTotal - Number(proposal.nte)).toFixed(2)} over the client's NTE of $${Number(proposal.nte).toFixed(2)}. Get NTE approval before sending, or bring the price down.`,
      })
    }

    // ---- 3. Global Maintenance Network business rules (gated to that
    // entity -- CBRE/Nexa Fix/etc proposals are unaffected).
    const isGmn = proposal.entity_id === GMN_ENTITY_ID
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

    // ---- 4. AI Learning: pull the same real approved/rejected/revision
    // history generate-proposal calibrates pricing against, so the model
    // below can judge this total against what's actually gotten through
    // for this client/trade, not just the narrative in isolation.
    const { contextText: outcomesContext, scopeLabel: outcomesScopeLabel, n: outcomesN } = await fetchOutcomeContext(supabase, client, tradeName)

    // ---- 5. AI check: does the narrative actually match what's being
    // billed, and does the price look like it'll face the kind of pushback
    // this client/trade has a track record of giving? Applies to any
    // entity, not just GMN.
    let overallAssessment = ''
    if (!GEMINI_API_KEY) {
      findings.push({
        severity: 'low',
        category: 'other',
        message: 'GEMINI_API_KEY is not configured for this project, so the narrative-vs-line-items scope check could not run. Only the deterministic pricing/tax/NTE checks above ran.',
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
You are auditing an ALREADY-WRITTEN maintenance/repair proposal before it goes out, specifically checking (1) whether what's being billed on the line items actually matches the scope described in the narrative, and (2) whether the total price looks likely to face the kind of pushback this client/trade has a track record of giving. You are not drafting anything and not re-pricing anything -- only flagging issues for a human dispatcher to review.

Work order: ${proposal.wo}
Client: ${client ?? 'Unknown'}
Trade: ${tradeName ?? 'Unknown'}
Location: ${[proposal.city ?? workOrder?.city, proposal.state ?? workOrder?.state].filter(Boolean).join(', ') || 'Unknown'}
Priority: ${proposal.priority ?? '(none set)'}
Client's NTE (Not-To-Exceed) for this job: ${proposal.nte != null ? `$${Number(proposal.nte).toFixed(2)}` : 'not set'}
Current total: $${currentTotal.toFixed(2)}

Narrative (scope of work as written for the client):
${proposal.narrative_scope}

${proposal.narrative_findings ? `Findings on site:\n${proposal.narrative_findings}\n` : ''}${proposal.narrative_recommendation ? `Recommendation:\n${proposal.narrative_recommendation}\n` : ''}${proposal.technician_notes ? `Technician's raw notes:\n${proposal.technician_notes}\n` : ''}
Line items currently billed:
${lineItemsText}

${outcomesContext || 'No labeled approval/rejection history is available yet for this client/trade.'}

Look specifically for:
1. Scope mismatches -- a line item implies a bigger or different job than the narrative describes (the clearest example: narrative says a door was REPAIRED/fixed, but a line item bills a brand-new/replacement door; or narrative describes a simple fix but parts/labor reflect a full replacement). Category: "scope_mismatch".
2. Parts or labor that don't seem related to anything in the narrative at all. Category: "scope_mismatch".
3. Something the narrative implies was done or is needed, with no corresponding line item (missing charges). Category: "scope_mismatch".
4. Whether this total, or the hours/parts behind it, looks like it resembles patterns this client/trade has previously rejected or asked to revise (per the history above) -- e.g. similar hours for a similar job that got pushed back. Category: "pricing_risk". Do not flag this just for being close to the NTE -- NTE is checked separately; only flag a real resemblance to a past rejection pattern.
5. Any other clear inconsistency. Category: "other".

Do not flag normal incidentals (disposal, minor hardware, trip/assessment fees, sales tax) as mismatches. Do not re-judge whether the price is fair in the abstract -- only scope-vs-billing consistency and resemblance to real rejection history. If everything lines up, return an empty findings array and say so in overall_assessment.
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
                category: { type: 'STRING', enum: ['scope_mismatch', 'pricing_risk', 'other'] },
                message: { type: 'STRING' },
              },
              required: ['severity', 'category', 'message'],
            },
          },
          overall_assessment: {
            type: 'STRING',
            description: 'One or two sentences on whether the narrative and the billed line items agree overall, and whether the price looks consistent with approval history.',
          },
        },
        required: ['findings', 'overall_assessment'],
      }

      const geminiRes = await callGeminiWithRetry([{ text: promptText }], responseSchema)

      if (!geminiRes.ok) {
        const label = geminiRes.status === 429 ? "Gemini's rate limit is maxed out" : geminiRes.status === 503 ? "Gemini's servers are temporarily overloaded" : geminiRes.status === 504 ? 'the AI took too long to respond' : `the AI call failed (${geminiRes.status})`
        findings.push({ severity: 'low', category: 'other', message: `Could not run the narrative/pricing scope check -- ${label}. The deterministic pricing/tax/NTE checks above still ran. Try again in a bit.` })
      } else {
        const geminiJson = await geminiRes.json()
        const rawText: string = (geminiJson.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
        try {
          const parsed = JSON.parse(rawText) as { findings?: { severity: Severity; category?: string; message: string }[]; overall_assessment?: string }
          for (const f of parsed.findings ?? []) {
            findings.push({ severity: f.severity, category: f.category ?? 'scope_mismatch', message: f.message })
          }
          overallAssessment = parsed.overall_assessment ?? ''
        } catch {
          findings.push({ severity: 'low', category: 'other', message: 'The AI scope check returned malformed output and was skipped. The deterministic pricing/tax/NTE checks above still ran.' })
        }
      }
    }

    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => order[a.severity] - order[b.severity])

    return jsonResponse({
      findings,
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
// there's enough (4+) labeled history to say something useful. Condensed
// relative to generate-proposal's version (no linked-proposal line-item
// enrichment) since this is a sanity check, not a drafting prompt.
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
