import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
// gemini-2.5-flash was retired for new users (as of testing); gemini-3.8-flash
// is the current default free-tier Flash model. Google swaps these out
// periodically -- if this starts 404ing again, bump it (via the GEMINI_MODEL
// secret) to whatever model id shows under your project at
// https://aistudio.google.com/app/apikey.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Gemini's documented image inputs are jpeg/png/webp (no gif).
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_PHOTOS = 6
// Gemini's inline (base64-in-request) payload is capped per request (~20MB
// total), not per image -- keep each photo small so 6 of them stay well
// under that ceiling. Use the File API instead if you need larger photos.
const MAX_PHOTO_BYTES = 3_000_000

type LaborRate = { id: string; role_name: string; hourly_cost: number }
type Part = { id: string; sku: string | null; name: string; unit_cost: number; unit: string; category: string | null }

type DraftLineItem = {
  kind: 'labor' | 'part' | 'other'
  description: string
  role_name?: string
  part_name?: string
  quantity: number
  suggested_unit_cost?: number
}

type Draft = {
  narrative_scope: string
  narrative_findings: string
  narrative_recommendation: string
  line_items: DraftLineItem[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    if (!GEMINI_API_KEY) {
      return jsonResponse(
        { error: 'GEMINI_API_KEY is not configured for this project. Ask a Super Admin to set it as an Edge Function secret.' },
        500,
      )
    }

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

    // Scoped to the caller's own JWT -- RLS (not this function) decides what they can read/write.
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

    if (proposal.status === 'approved' || proposal.status === 'sent') {
      return jsonResponse(
        { error: `This proposal is already ${proposal.status} and can't be regenerated. Create a new proposal for this work order instead.` },
        409,
      )
    }

    if (!proposal.technician_notes || !proposal.technician_notes.trim()) {
      return jsonResponse({ error: 'Add technician notes to the proposal before generating a draft.' }, 400)
    }

    const flatQuote = proposal.technician_flat_quote != null ? Number(proposal.technician_flat_quote) : null
    const isFlatQuoteMode = flatQuote != null && !Number.isNaN(flatQuote) && flatQuote > 0

    const { data: workOrder } = await supabase
      .from('work_orders')
      .select('wo, client, trade, subtrade, address, city, state, nte, description')
      .eq('wo', proposal.wo)
      .maybeSingle()

    const { data: photos } = await supabase
      .from('proposal_photos')
      .select('id, storage_path, caption, sort_order')
      .eq('proposal_id', proposalId)
      .order('sort_order', { ascending: true })

    const { data: laborRates } = await supabase
      .from('labor_rates')
      .select('id, role_name, hourly_cost')
      .eq('active', true)
    const { data: parts } = await supabase
      .from('parts_price_list')
      .select('id, sku, name, unit_cost, unit, category')
      .eq('active', true)

    const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = []
    for (const photo of (photos ?? []).slice(0, MAX_PHOTOS)) {
      try {
        const { data: fileBlob, error: dlErr } = await supabase.storage
          .from('proposal-photos')
          .download(photo.storage_path)
        if (dlErr || !fileBlob) continue
        if (fileBlob.size > MAX_PHOTO_BYTES) continue
        const mediaType = fileBlob.type && ALLOWED_IMAGE_TYPES.has(fileBlob.type) ? fileBlob.type : guessMediaType(photo.storage_path)
        if (!ALLOWED_IMAGE_TYPES.has(mediaType)) continue
        const bytes = new Uint8Array(await fileBlob.arrayBuffer())
        imageParts.push({
          inlineData: { mimeType: mediaType, data: base64FromBytes(bytes) },
        })
      } catch {
        // Skip an unreadable photo rather than failing the whole generation.
      }
    }

    const laborList = (laborRates ?? []).map((r: LaborRate) => `- ${r.role_name}`).join('\n') || '(none configured yet)'
    const partsList =
      (parts ?? [])
        .map((p: Part) => `- ${p.name}${p.sku ? ` (SKU ${p.sku})` : ''}${p.category ? ` [${p.category}]` : ''}`)
        .join('\n') || '(none configured yet)'

    const flatQuoteContext = isFlatQuoteMode
      ? `Context: the technician gave the dispatcher one flat all-in price of $${flatQuote} for this entire job (covering labor and any parts/materials together) -- that is the fixed amount the dispatcher will actually pay him. You should still estimate a normal, itemized hours/parts breakdown below for the client-facing proposal, exactly as you would for an hourly job -- the system will proportionally scale your estimated costs so the breakdown always totals the technician's $${flatQuote} ask, so focus on a realistic, well-proportioned breakdown rather than trying to hit that dollar total yourself.\n\n`
      : ''

    const modeSection = `
${flatQuoteContext}Decide, from the notes (and photos, if present), how many hours of labor this job genuinely needs, and whether it requires a second person (a helper) in addition to the technician. Most small jobs don't need a helper -- only add one when the work truly calls for an extra set of hands (heavy or awkward material, working at height, holding something while the other person works, etc).

Technician/helper hourly rates set by the dispatcher for this job -- use role_name exactly "Technician" for the primary tech's hours and exactly "Helper" for a second person's hours, rather than inventing another role name for them:
- Technician: ${proposal.technician_rate != null ? `$${proposal.technician_rate}/hr` : 'not provided -- still estimate the hours needed; the dispatcher will price it manually'}
- Helper: ${proposal.helper_rate != null ? `$${proposal.helper_rate}/hr` : "not provided -- only add a Helper line item if the job truly needs one, even without a known rate; the dispatcher will price it manually"}

Known labor roles catalog (use one of these exact names instead of "Technician"/"Helper" only if a line item is clearly a different, specialized trade role not covered by the two rates above; if none fit, invent a short clear role name):
${laborList}

Known parts catalog (use these exact names when a line item is a stocked part; if the part isn't listed, use "other" instead):
${partsList}

Parts/materials -- think like an experienced technician in this trade, not a transcriptionist: decide what parts and materials this job actually required based on the work described (trade/subtrade, what was diagnosed, what was done), using the technician's notes as your primary source but not limited only to what they explicitly itemized. If the notes describe a repair or replacement (e.g. "replaced the leaking shutoff valve," "swapped the failed ballast"), infer the specific parts that job realistically consumes even when the technician didn't spell every one out (a valve swap typically also needs fittings/tape/sealant; a ballast swap may need wire nuts; etc.) -- use your trade knowledge, not generic guesses. Create a SEPARATE kind="part" line item for each distinct part you can reasonably identify, with a realistic quantity each.
Do NOT invent parts the job wouldn't plausibly need, and do NOT pad the list with vague filler ("miscellaneous materials," "misc parts") just to have something there.
If the work described is purely diagnostic/inspection, troubleshooting with no repair performed, a visit where nothing was replaced, or otherwise genuinely required no parts or materials, return ZERO kind="part" line items for this proposal -- never force a parts line onto a job that didn't use any.
`.trim()

    const lineItemRules = `- line_items: one per distinct task or material. kind="labor" for people's time (role_name "Technician", "Helper", or a catalog role as described above), kind="part" for a stocked part (part_name should match the catalog when possible), kind="other" for anything that is not labor or a cataloged part (permits, disposal fees, equipment rental, etc) -- for "other" items only, also supply suggested_unit_cost (your best estimate of the cost in USD, before markup).
- quantity is the number of hours (labor) or count/units (part/other).
- Do not include markup, margin, or price in your line items -- only cost-side quantity/role/part. Pricing is computed separately by the system.`

    const contextText = `
You are helping a facilities-maintenance dispatcher turn field technician notes into a client-facing repair/service proposal.

Work order: ${workOrder?.wo ?? proposal.wo}
Store/client: ${workOrder?.client ?? 'Unknown'}
Trade / Subtrade: ${workOrder?.trade ?? 'Unknown'} / ${workOrder?.subtrade ?? 'n/a'}
Location: ${[workOrder?.address, workOrder?.city, workOrder?.state].filter(Boolean).join(', ') || 'Unknown'}
Original issue description: ${workOrder?.description ?? 'n/a'}

Technician field notes:
"""
${proposal.technician_notes}
"""
${imageParts.length ? `\n${imageParts.length} technician photo(s) are attached below for visual context.` : ''}

${modeSection}

Write a client-facing proposal draft as a single JSON object matching the required schema. Rules:
- narrative_scope: 2-4 sentences, written like an experienced facilities estimator, describing what work this job covers in plain, professional language a store manager would understand. Ground it in the specifics from the technician's notes (the actual component, system, and location involved) -- never fall back on generic phrasing like "various issues were addressed" when the notes give you something concrete to say instead.
- narrative_findings: what the technician found on site -- the specific condition, likely cause, and extent of the issue, explained the way a skilled tech would walk a non-technical client through it. Pull in concrete details actually present in the notes (what was inspected or tested, what had failed, how severe it was) rather than summarizing in the abstract.
- narrative_recommendation: the recommended fix and the reasoning behind it, in confident, plain language the client can act on without translation. If the notes describe work already completed, frame this as the fix that was performed and why it was the right call; if they describe a recommended next step, lead with that recommendation.
- Across all three narrative fields: write every sentence as if it were observed on this specific job, never as reusable boilerplate. Match your level of specificity to the detail actually present in the notes -- be as concrete as the notes allow, and don't pad with invented generic language ("general maintenance," "some issues") just to fill space.
${lineItemRules}
- Keep line items grounded in what the notes (and photos, if present) actually describe, plus the trade-informed parts inference above. Don't invent unrelated work.
`.trim()

    const responseSchema = {
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
              role_name: { type: 'STRING' },
              part_name: { type: 'STRING' },
              quantity: { type: 'NUMBER' },
              suggested_unit_cost: { type: 'NUMBER' },
            },
            required: ['kind', 'description', 'quantity'],
          },
        },
      },
      required: ['narrative_scope', 'narrative_findings', 'narrative_recommendation', 'line_items'],
    }

    const userParts: unknown[] = [{ text: contextText }, ...imageParts]

    const geminiRes = await callGeminiWithRetry(userParts, responseSchema)

    if (!geminiRes.ok) {
      const errText = await geminiRes.text()
      if (geminiRes.status === 429) {
        return jsonResponse(
          { error: "Gemini's free-tier rate limit (a few requests per minute) is maxed out and a retry didn't clear it in time. Wait about a minute before trying again." },
          429,
        )
      }
      if (geminiRes.status === 503) {
        return jsonResponse(
          { error: "Gemini's free-tier servers are temporarily overloaded. Wait a few seconds and try again." },
          503,
        )
      }
      return jsonResponse({ error: `AI generation failed (${geminiRes.status}): ${errText}` }, 502)
    }

    const geminiJson = await geminiRes.json()
    const candidate = geminiJson.candidates?.[0]
    const rawText: string = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? '')
      .join('')

    if (!rawText) {
      const blockReason = geminiJson.promptFeedback?.blockReason
      return jsonResponse(
        { error: blockReason ? `The AI declined to generate a draft (${blockReason}).` : 'The AI did not return a structured draft. Try again.' },
        502,
      )
    }

    let draft: Draft
    try {
      draft = JSON.parse(rawText)
    } catch {
      return jsonResponse({ error: 'The AI returned malformed JSON. Try again.' }, 502)
    }

    const effectiveLineItems: DraftLineItem[] = draft.line_items ?? []

    const markupMult = 1 + (Number(proposal.markup_pct) || 0) / 100
    const laborByName = new Map((laborRates ?? []).map((r: LaborRate) => [r.role_name.toLowerCase().trim(), r]))
    const partsByName = new Map((parts ?? []).map((p: Part) => [p.name.toLowerCase().trim(), p]))

    const rawLineItemRows = effectiveLineItems.map((li, idx) => {
      let roleId: string | null = null
      let partId: string | null = null
      let unitCost = 0
      let needsManualPricing = false

      if (li.kind === 'labor') {
        const roleKey = (li.role_name ?? '').toLowerCase().trim()
        if (roleKey === 'technician' && proposal.technician_rate != null) {
          unitCost = Number(proposal.technician_rate) || 0
        } else if (roleKey === 'helper' && proposal.helper_rate != null) {
          unitCost = Number(proposal.helper_rate) || 0
        } else {
          const match = li.role_name ? (laborByName.get(roleKey) as LaborRate | undefined) : undefined
          if (match) {
            roleId = match.id
            unitCost = Number(match.hourly_cost) || 0
          } else {
            // "Technician"/"Helper" with no rate entered falls here too --
            // flagged for the dispatcher to price by hand, same as an
            // unmatched catalog role.
            needsManualPricing = true
          }
        }
      } else if (li.kind === 'part') {
        const match = li.part_name ? (partsByName.get(li.part_name.toLowerCase().trim()) as Part | undefined) : undefined
        if (match) {
          partId = match.id
          unitCost = Number(match.unit_cost) || 0
        } else {
          needsManualPricing = true
        }
      } else {
        unitCost = Number(li.suggested_unit_cost) || 0
        needsManualPricing = true
      }

      const unitPrice = round2(unitCost * markupMult)

      return {
        proposal_id: proposalId,
        kind: li.kind,
        description: li.description,
        role_id: roleId,
        part_id: partId,
        quantity: li.quantity ?? 1,
        unit_cost: unitCost,
        unit_price: unitPrice,
        needs_manual_pricing: needsManualPricing,
        ai_suggested: true,
        sort_order: idx,
      }
    })

    // In flat-quote mode the technician's real ask is a single fixed dollar
    // amount, not the sum of catalog/hourly rates -- so after estimating a
    // normal-looking hours/parts breakdown above (for the client-facing
    // itemization), scale every line's cost proportionally so the breakdown's
    // total cost always reconciles to exactly what the technician quoted.
    // If the AI couldn't produce any priceable breakdown at all, fall back to
    // a single flat-quote line so the technician's ask is still captured.
    let lineItemRows = rawLineItemRows
    if (isFlatQuoteMode) {
      const naturalTotalCost = rawLineItemRows.reduce((s, r) => s + r.quantity * r.unit_cost, 0)
      if (naturalTotalCost > 0) {
        const scale = flatQuote! / naturalTotalCost
        lineItemRows = rawLineItemRows.map((r) => {
          const scaledCost = round2(r.unit_cost * scale)
          return { ...r, unit_cost: scaledCost, unit_price: round2(scaledCost * markupMult) }
        })
      } else {
        lineItemRows = [
          {
            proposal_id: proposalId,
            kind: 'labor' as const,
            description: 'Technician labor and parts (flat quote)',
            role_id: null,
            part_id: null,
            quantity: 1,
            unit_cost: flatQuote!,
            unit_price: round2(flatQuote! * markupMult),
            needs_manual_pricing: false,
            ai_suggested: true,
            sort_order: 0,
          },
        ]
      }
    }

    // Trip Fee / Assessment Fee are fixed amounts the dispatcher enters by
    // hand, separate from the technician's labor/parts cost (and from any
    // flat-quote reconciliation above) -- billed to the client at exactly
    // what was entered, with no markup applied.
    const tripFee = proposal.trip_fee != null ? Number(proposal.trip_fee) : null
    if (tripFee != null && !Number.isNaN(tripFee) && tripFee > 0) {
      lineItemRows = [
        ...lineItemRows,
        {
          proposal_id: proposalId,
          kind: 'other' as const,
          description: 'Trip Fee',
          role_id: null,
          part_id: null,
          quantity: 1,
          unit_cost: tripFee,
          unit_price: tripFee,
          needs_manual_pricing: false,
          ai_suggested: true,
          sort_order: lineItemRows.length,
        },
      ]
    }
    const assessmentFee = proposal.assessment_fee != null ? Number(proposal.assessment_fee) : null
    if (assessmentFee != null && !Number.isNaN(assessmentFee) && assessmentFee > 0) {
      lineItemRows = [
        ...lineItemRows,
        {
          proposal_id: proposalId,
          kind: 'other' as const,
          description: 'Assessment Fee',
          role_id: null,
          part_id: null,
          quantity: 1,
          unit_cost: assessmentFee,
          unit_price: assessmentFee,
          needs_manual_pricing: false,
          ai_suggested: true,
          sort_order: lineItemRows.length,
        },
      ]
    }

    // Regenerating replaces only the previously AI-suggested rows; anything the
    // dispatcher added by hand (ai_suggested = false) is left untouched.
    await supabase.from('proposal_line_items').delete().eq('proposal_id', proposalId).eq('ai_suggested', true)

    if (lineItemRows.length) {
      const { error: insertErr } = await supabase.from('proposal_line_items').insert(lineItemRows)
      if (insertErr) {
        return jsonResponse({ error: `Failed to save line items: ${insertErr.message}` }, 500)
      }
    }

    const { data: allItems } = await supabase
      .from('proposal_line_items')
      .select('quantity, unit_cost, unit_price')
      .eq('proposal_id', proposalId)
    const subtotalCost = (allItems ?? []).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost), 0)
    const subtotalPrice = (allItems ?? []).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0)
    const marginPct = subtotalPrice > 0 ? ((subtotalPrice - subtotalCost) / subtotalPrice) * 100 : null

    const { data: updatedProposal, error: updateErr } = await supabase
      .from('proposals')
      .update({
        narrative_scope: draft.narrative_scope,
        narrative_findings: draft.narrative_findings,
        narrative_recommendation: draft.narrative_recommendation,
        status: 'ai_generated',
        ai_model: geminiJson.modelVersion ?? GEMINI_MODEL,
        ai_generated_at: new Date().toISOString(),
        ai_raw_response: geminiJson,
        subtotal_cost: round2(subtotalCost),
        subtotal_price: round2(subtotalPrice),
        margin_pct: marginPct === null ? null : round2(marginPct),
      })
      .eq('id', proposalId)
      .select()
      .single()

    if (updateErr) {
      return jsonResponse({ error: `Failed to save proposal: ${updateErr.message}` }, 500)
    }

    return jsonResponse({ proposal: updatedProposal, line_items_count: lineItemRows.length })
  } catch (e) {
    return jsonResponse({ error: `Unexpected error: ${(e as Error).message}` }, 500)
  }
})

// Two different failure modes here, handled differently:
//  - 503 "high demand": shared free-tier capacity hiccup. A short backoff
//    retry usually clears it.
//  - 429 "quota exceeded": the free tier allows only a handful of requests
//    PER MINUTE per model. A fast retry just burns another slot in the same
//    window and gets rejected again -- it only helps to wait roughly as long
//    as Google's own error tells us to (its `retryDelay`), so we do that,
//    once. Anything else (bad request, auth, daily quota gone) fails fast.
async function callGeminiWithRetry(userParts: unknown[], responseSchema: unknown): Promise<Response> {
  const maxAttempts = 2
  let res: Response
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY!,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: {
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
      },
    )
    if (res.ok) return res
    if (attempt === maxAttempts) return res

    if (res.status === 503) {
      await res.body?.cancel()
      await new Promise((r) => setTimeout(r, 2500))
      continue
    }

    if (res.status === 429) {
      let delayMs = 15000
      try {
        const errBody = await res.clone().json()
        const retryInfo = (errBody?.error?.details ?? []).find((d: { ['@type']?: string }) =>
          d['@type']?.includes('RetryInfo'),
        )
        const raw = retryInfo?.retryDelay as string | undefined // e.g. "17s"
        const secs = raw ? parseFloat(raw) : NaN
        if (!Number.isNaN(secs)) delayMs = Math.min(Math.ceil(secs * 1000) + 500, 25000)
      } catch {
        // Couldn't parse it -- fall back to the default delayMs above.
      }
      await res.body?.cancel()
      await new Promise((r) => setTimeout(r, delayMs))
      continue
    }

    return res
  }
  return res!
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

function guessMediaType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

// Chunked base64 encoding -- String.fromCharCode(...bytes) spreads the whole
// array as call arguments and overflows the call stack on larger images.
function base64FromBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
