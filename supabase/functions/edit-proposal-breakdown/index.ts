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
// This function returns as soon as those two stages are done. The AI
// scope-consistency + parts-pricing + pricing-history check that used to
// also run here now lives in its own function, check-breakdown-scope,
// which the frontend calls right after this one returns -- so the edited
// breakdown shows up as soon as this (faster) pass finishes instead of
// waiting for both AI calls before showing anything.
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

    // ---- Done -- hand back the edited breakdown right away. (See the
    // file-top comment: the AI scope/parts-pricing/history check that used
    // to run here as a further stage now lives in check-breakdown-scope.) ----
    const overallAssessment = edited.edit_summary ?? ''
    if (corrected.length === 0) {
      findings.push({ severity: 'low', category: 'other', message: 'No line items left after this edit.' })
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
