import { createClient } from 'jsr:@supabase/supabase-js@2'

// Companion to audit-proposal-text, for revising an already-checked
// breakdown with a free-form instruction from the dispatcher (e.g. "add a
// $50 disposal fee", "the narrative should say replaced, not repaired").
// This does NOT re-run the deterministic GMN/price-list auto-fixing that
// audit-proposal-text does on a fresh paste -- the dispatcher is making a
// deliberate change here, and silently overriding it back with the rate
// sheet would undo what they just asked for. Instead:
//   1. Gemini applies the instruction to the narrative + line items,
//      leaving everything else untouched, and marks which lines it
//      changed.
//   2. The result's NTE status is checked (informational only -- same
//      "still over NTE" message audit-proposal-text shows, never blocks
//      the edit).
//   3. The SAME AI scope-consistency + parts-pricing + pricing-history
//      check audit-proposal-text runs is run again against the edited
//      result, so findings stay current.
// Nothing here is saved anywhere, same as audit-proposal-text.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash'
const GEMINI_ATTEMPT_TIMEOUT_MS = 110000
const MAX_TRANSIENT_RETRIES = 1

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Severity = 'high' | 'medium' | 'low'
type LineItem = { kind: 'labor' | 'part' | 'other'; description: string; role_name?: string; quantity: number; unit_price: number }
type CorrectedLineItem = LineItem & { changed: boolean; note: string | null }

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

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
      narrative_scope?: string
      narrative_findings?: string
      narrative_recommendation?: string
      line_items?: LineItem[]
      instruction?: string
    }
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    const instruction = (body.instruction ?? '').trim()
    if (!instruction) {
      return jsonResponse({ error: 'Describe what to change first.' }, 400)
    }
    const currentItems: LineItem[] = (body.line_items ?? []).map((li) => ({
      kind: li.kind,
      description: li.description,
      role_name: li.role_name || undefined,
      quantity: Number(li.quantity) || 0,
      unit_price: Number(li.unit_price) || 0,
    }))

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    const nte = body.nte != null && !Number.isNaN(Number(body.nte)) ? Number(body.nte) : null

    // ---- Stage 1: Gemini applies the instruction. ----
    const editSchema = {
      type: 'OBJECT',
      properties: {
        narrative_scope: { type: 'STRING' },
        narrative_findings: { type: 'STRING' },
        narrative_recommendation: { type: 'STRING' },
        line_items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              kind: { type: 'STRING', enum: ['labor', 'part', 'other'] },
              description: { type: 'STRING' },
              role_name: {
                type: 'STRING',
                description: 'Labor lines only: "Technician", "Helper", "Trip Fee", or "Assessment Fee" if that\'s what the line is, else the stated trade. Empty for parts/other.',
              },
              quantity: { type: 'NUMBER' },
              unit_price: { type: 'NUMBER', description: 'Per-unit/per-hour price.' },
              changed: {
                type: 'BOOLEAN',
                description: "true ONLY if you added this line or changed its quantity/price/description/kind because of the instruction. false for every line left exactly as it was.",
              },
              note: { type: 'STRING', description: 'One short phrase on what changed and why, only when changed is true. Empty string otherwise.' },
            },
            required: ['kind', 'description', 'quantity', 'unit_price', 'changed', 'note'],
          },
        },
        edit_summary: { type: 'STRING', description: 'One or two sentences summarizing what you changed. If the instruction was ambiguous, say what you assumed.' },
      },
      required: ['narrative_scope', 'line_items', 'edit_summary'],
    }

    const editPrompt = `
You are editing an already-written, already-priced maintenance/repair proposal, based on a direct instruction from the dispatcher who wrote it. Apply EXACTLY what the instruction asks and nothing more -- do not "improve" wording, do not re-judge or correct prices the instruction doesn't mention, do not add or remove anything the instruction didn't ask for. Leave everything else byte-for-byte as it is.

Work order: ${body.wo || 'n/a'}
Client: ${body.client_name || 'n/a'}
Trade: ${body.trade_name || 'n/a'}
Client's NTE (Not-To-Exceed) for this job: ${nte != null ? `$${nte.toFixed(2)}` : 'not set'}

Current narrative:
${body.narrative_scope || '(none)'}
${body.narrative_findings ? `\nFindings:\n${body.narrative_findings}` : ''}
${body.narrative_recommendation ? `\nRecommendation:\n${body.narrative_recommendation}` : ''}

Current line items:
${currentItems.map((li, i) => `${i + 1}. [${li.kind}]${li.role_name ? ` (${li.role_name})` : ''} ${li.description} -- qty ${li.quantity} x $${li.unit_price.toFixed(2)} = $${(li.quantity * li.unit_price).toFixed(2)}`).join('\n') || '(none)'}

Dispatcher's instruction:
"""
${instruction}
"""

Apply the instruction, then return the FULL updated narrative and the FULL updated line items array -- including every line you left alone, copied over exactly (and simply leave out any line the instruction asked you to remove). If the instruction asks to add a line with a stated price, use that exact price; if it asks for something with no price stated, use your best reasonable market estimate and say so clearly in that line's note so the dispatcher knows to double check it. If the instruction is ambiguous, make the most reasonable interpretation and explain what you assumed in edit_summary. Never touch quantities, prices, or wording the instruction doesn't address.
`.trim()

    const editRes = await callGeminiWithRetry([{ text: editPrompt }], editSchema, 8192)
    if (!editRes.ok) {
      return jsonResponse({ error: await geminiErrorMessage(editRes) }, editRes.status === 200 ? 502 : editRes.status)
    }
    const editJson = await editRes.json()
    const editCandidate = editJson.candidates?.[0]
    const editRawText: string = (editCandidate?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
    // A response cut off at the token limit lands here as non-empty but
    // truncated JSON -- catch it by finishReason before attempting to
    // parse, rather than letting it surface as a generic "malformed" error.
    if (editCandidate?.finishReason === 'MAX_TOKENS') {
      return jsonResponse({ error: 'That edit produced too much text and got cut off. Try a shorter, more specific instruction, or split it into smaller edits.' }, 502)
    }
    if (!editRawText) {
      return jsonResponse({ error: 'The AI could not apply that edit. Try rephrasing the instruction.' }, 502)
    }
    let edited: { narrative_scope: string; narrative_findings?: string; narrative_recommendation?: string; line_items: (LineItem & { changed?: boolean; note?: string })[]; edit_summary?: string }
    try {
      edited = JSON.parse(editRawText)
    } catch {
      return jsonResponse({ error: 'The AI returned malformed output while applying the edit. Try again.' }, 502)
    }

    const corrected: CorrectedLineItem[] = (edited.line_items ?? []).map((li) => ({
      kind: li.kind,
      description: li.description,
      role_name: li.role_name || undefined,
      quantity: Number(li.quantity) || 0,
      unit_price: Number(li.unit_price) || 0,
      changed: !!li.changed,
      note: li.changed && li.note ? li.note : null,
    }))

    const subtotalBefore = round2(currentItems.reduce((s, li) => s + li.quantity * li.unit_price, 0))
    const subtotalAfter = round2(corrected.reduce((s, li) => s + li.quantity * li.unit_price, 0))

    const findings: { severity: Severity; category: string; message: string }[] = []

    // ---- Stage 2: NTE status -- informational only, never blocks or
    // reverts the edit (the dispatcher asked for this change on purpose). ----
    if (nte != null && nte > 0 && subtotalAfter > nte + 0.01) {
      findings.push({
        severity: 'high',
        category: 'nte',
        message: `This breakdown totals $${subtotalAfter.toFixed(2)}, which is $${(subtotalAfter - nte).toFixed(2)} over the client's NTE of $${nte.toFixed(2)}. Get NTE approval, or decide what to trim before sending.`,
      })
    }

    // ---- Stage 3: AI Learning context, same cascade generate-proposal /
    // audit-proposal-text use. ----
    const { contextText: outcomesContext, scopeLabel: outcomesScopeLabel, n: outcomesN } = await fetchOutcomeContext(
      supabase,
      body.client_name ?? null,
      body.trade_name ?? null,
    )

    // ---- Stage 4: AI scope-consistency + parts-pricing + pricing-risk
    // check against the edited items -- flagged only, same checks
    // audit-proposal-text runs, so findings stay current after the edit. ----
    const overallAssessment = edited.edit_summary ?? ''
    if (corrected.length === 0) {
      findings.push({ severity: 'low', category: 'other', message: 'No line items left after this edit.' })
    } else {
      const partsOnBill = corrected.filter((li) => li.kind === 'part')
      let partsCatalogText = ''
      if (body.entity_id && partsOnBill.length > 0) {
        const { data: partsCatalog } = await supabase
          .from('parts_price_list')
          .select('name, unit_cost, unit, category')
          .eq('entity_id', body.entity_id)
          .eq('active', true)
          .limit(300)
        if (partsCatalog && partsCatalog.length > 0) {
          partsCatalogText = `\nThis entity's parts price list (for comparison only -- a billed part with no clear match here isn't necessarily wrong, it may just not be a catalog item):\n${partsCatalog
            .map((p: { name: string; unit_cost: number; unit: string; category: string | null }) => `- ${p.name}: $${Number(p.unit_cost).toFixed(2)} / ${p.unit}${p.category ? ` (${p.category})` : ''}`)
            .join('\n')}`
        }
      }

      const lineItemsText = corrected.map((li) => `- [${li.kind}] ${li.description} -- qty ${li.quantity}, bills $${(li.quantity * li.unit_price).toFixed(2)}`).join('\n')
      const scopePrompt = `
You are auditing an already-written maintenance/repair proposal (just revised per a dispatcher instruction), checking (1) whether the billed line items actually match the scope described in the narrative, (2) whether billed parts look consistent with this entity's parts price list, and (3) whether the total resembles patterns this client/trade has previously gotten pushed back on. Do not re-judge whether the price is fair in the abstract -- only scope-vs-billing consistency, parts-vs-catalog consistency, and resemblance to real rejection history.

Work order: ${body.wo || 'n/a'}
Client: ${body.client_name || 'n/a'}
Trade: ${body.trade_name || 'n/a'}
Client's NTE (Not-To-Exceed) for this job: ${nte != null ? `$${nte.toFixed(2)}` : 'not set'}
Current total: $${subtotalAfter.toFixed(2)}

Narrative:
${edited.narrative_scope || '(none)'}
${edited.narrative_findings ? `\nFindings:\n${edited.narrative_findings}` : ''}
${edited.narrative_recommendation ? `\nRecommendation:\n${edited.narrative_recommendation}` : ''}

Line items currently billed:
${lineItemsText}
${partsCatalogText}

${outcomesContext || 'No labeled approval/rejection history is available yet for this client/trade.'}

Look specifically for:
1. Scope mismatches -- a line item implies a bigger or different job than the narrative describes. Category: "scope_mismatch".
2. Parts or labor unrelated to anything in the narrative. Category: "scope_mismatch".
3. Something the narrative implies was done or is needed, with no corresponding line item. Category: "scope_mismatch".
4. Parts pricing -- only if a parts price list was provided above: a billed part whose price is clearly out of line with a catalog item you're confident it corresponds to. Category: "parts_pricing". Be conservative: only flag a real, confident correspondence, and treat a catalog entry marked "VARIABLE" or "confirm with vendor" as a range, not an exact price to match.
5. Whether this total, or the hours/parts behind it, resembles patterns this client/trade has previously rejected or asked to revise (per the history above). Category: "pricing_risk". Do not flag this just for being close to the NTE -- that's checked separately.
6. Any other clear inconsistency. Category: "other".

If everything lines up, return an empty findings array.
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
                category: { type: 'STRING', enum: ['scope_mismatch', 'parts_pricing', 'pricing_risk', 'other'] },
                message: { type: 'STRING' },
              },
              required: ['severity', 'category', 'message'],
            },
          },
        },
        required: ['findings'],
      }
      const scopeRes = await callGeminiWithRetry([{ text: scopePrompt }], scopeSchema)
      if (!scopeRes.ok) {
        findings.push({ severity: 'low', category: 'other', message: `Could not run the narrative/pricing scope check -- ${await geminiErrorMessage(scopeRes)}` })
      } else {
        const scopeJson = await scopeRes.json()
        const scopeRawText: string = (scopeJson.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
        try {
          const scopeParsed = JSON.parse(scopeRawText) as { findings?: { severity: Severity; category?: string; message: string }[] }
          for (const f of scopeParsed.findings ?? []) findings.push({ severity: f.severity, category: f.category ?? 'scope_mismatch', message: f.message })
        } catch {
          findings.push({ severity: 'low', category: 'other', message: 'The AI scope check returned malformed output and was skipped.' })
        }
      }
    }

    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => order[a.severity] - order[b.severity])

    return jsonResponse({
      narrative_scope: edited.narrative_scope ?? '',
      narrative_findings: edited.narrative_findings ?? '',
      narrative_recommendation: edited.narrative_recommendation ?? '',
      corrected_line_items: corrected,
      fixes_applied: [],
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

// Same cascade generate-proposal / audit-proposal-text use: client+trade,
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
