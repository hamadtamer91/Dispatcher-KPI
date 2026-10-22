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
  pricing_note?: string
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

    // Read once up front -- used both to size the AI's target below and to
    // append the actual fee line items after the AI call.
    const tripFee = proposal.trip_fee != null && !Number.isNaN(Number(proposal.trip_fee)) ? Number(proposal.trip_fee) : 0
    const assessmentFee =
      proposal.assessment_fee != null && !Number.isNaN(Number(proposal.assessment_fee)) ? Number(proposal.assessment_fee) : 0

    const { data: workOrder } = await supabase
      .from('work_orders')
      .select('wo, client, trade, subtrade, address, city, state, nte, description')
      .eq('wo', proposal.wo)
      .maybeSingle()

    // AI Learning: real approved/rejected/revision-requested outcomes the
    // dispatcher has labeled (old quotes entered by hand, or past proposals
    // sent from this app), used as context so new proposals calibrate toward
    // what has actually gotten approved rather than pricing in a vacuum.
    // Same client + same trade is the most relevant history (a client like
    // CBRE may push back harder or more easily than others) -- cascade
    // outward (client+trade -> client only -> trade only -> everything)
    // until there's enough to say something useful.
    type OutcomeRow = {
      trade: string | null
      client: string | null
      total_price: number | null
      markup_pct: number | null
      outcome: string
      client_feedback: string | null
      job_description: string | null
      proposal_id: string | null
    }
    const outcomeClientName = proposal.client_name ?? workOrder?.client ?? null
    // Same idea as outcomeClientName -- this proposal's own Trade field
    // (dispatcher-entered) wins when set, so AI Learning matching still works
    // even for a job whose work order isn't in the Work Orders table yet or
    // has no trade filled in there.
    const outcomeTradeName = proposal.trade_name ?? workOrder?.trade ?? null
    const fetchOutcomes = async (filters: { client?: string; trade?: string }): Promise<OutcomeRow[]> => {
      let q = supabase
        .from('quote_outcomes')
        .select('trade, client, total_price, markup_pct, outcome, client_feedback, job_description, proposal_id')
        .order('created_at', { ascending: false })
        .limit(30)
      if (filters.client) q = q.ilike('client', filters.client)
      if (filters.trade) q = q.ilike('trade', filters.trade)
      const { data } = await q
      return data ?? []
    }

    let outcomeRows: OutcomeRow[] = []
    let outcomeScope: 'client_trade' | 'client' | 'trade' | 'all' = 'all'

    if (outcomeClientName && outcomeTradeName) {
      outcomeRows = await fetchOutcomes({ client: outcomeClientName, trade: outcomeTradeName })
      outcomeScope = 'client_trade'
    }
    if (outcomeRows.length < 4 && outcomeClientName) {
      outcomeRows = await fetchOutcomes({ client: outcomeClientName })
      outcomeScope = 'client'
    }
    if (outcomeRows.length < 4 && outcomeTradeName) {
      outcomeRows = await fetchOutcomes({ trade: outcomeTradeName })
      outcomeScope = 'trade'
    }
    if (outcomeRows.length < 4) {
      outcomeRows = await fetchOutcomes({})
      outcomeScope = 'all'
    }

    const outcomeScopeLabel =
      outcomeScope === 'client_trade'
        ? `for ${outcomeClientName} ${outcomeTradeName} jobs specifically`
        : outcomeScope === 'client'
          ? `for ${outcomeClientName} jobs across trades (not enough ${outcomeTradeName ?? 'this trade'}-specific history for them yet)`
          : outcomeScope === 'trade'
            ? `for ${outcomeTradeName} jobs generally (not enough history for ${outcomeClientName ?? 'this client'} specifically)`
            : 'across jobs generally (not enough labeled history yet)'

    // Outcomes logged from an actual in-app proposal (proposal_id set) have
    // far richer history than a manual entry's short job_description -- the
    // real narrative that was sent to the client, plus the actual line-item
    // breakdown (how many hours of Technician vs. Helper, which parts). Pull
    // that in so the AI can match a new job's scope/complexity to what level
    // of scope has tended to get approved at what price, not just a bare
    // number. A manual entry has none of that structure, so its pasted
    // job_description text (which often already is a full quote breakdown)
    // is used as-is instead.
    const linkedProposalIds = [...new Set(outcomeRows.map((r) => r.proposal_id).filter((id): id is string => !!id))]
    const detailByProposalId = new Map<string, string>()
    if (linkedProposalIds.length) {
      const { data: linkedProposals } = await supabase
        .from('proposals')
        .select('id, narrative_recommendation, technician_rate, helper_rate')
        .in('id', linkedProposalIds)
      const { data: linkedLineItems } = await supabase
        .from('proposal_line_items')
        .select('proposal_id, kind, description, quantity, unit_cost, labor_rates(role_name), parts_price_list(name)')
        .in('proposal_id', linkedProposalIds)

      const itemsByProposal = new Map<string, typeof linkedLineItems>()
      for (const li of linkedLineItems ?? []) {
        const list = itemsByProposal.get(li.proposal_id) ?? []
        list.push(li)
        itemsByProposal.set(li.proposal_id, list)
      }

      for (const p of linkedProposals ?? []) {
        const items = itemsByProposal.get(p.id) ?? []
        const closeTo = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.005

        const laborHoursByRole = new Map<string, number>()
        const partLabels: string[] = []
        for (const li of items) {
          if (li.kind === 'labor') {
            const roleName =
              (li as { labor_rates?: { role_name: string } | null }).labor_rates?.role_name ??
              (closeTo(li.unit_cost, p.technician_rate) ? 'Technician' : closeTo(li.unit_cost, p.helper_rate) ? 'Helper' : 'Labor')
            laborHoursByRole.set(roleName, (laborHoursByRole.get(roleName) ?? 0) + Number(li.quantity))
          } else if (li.kind === 'part') {
            const partName = (li as { parts_price_list?: { name: string } | null }).parts_price_list?.name ?? li.description
            partLabels.push(li.quantity > 1 ? `${partName} x${li.quantity}` : partName)
          }
        }
        const laborSummary = [...laborHoursByRole.entries()].map(([role, hrs]) => `${role} ${round2(hrs)}hr${hrs === 1 ? '' : 's'}`).join(', ')
        const partsSummary = partLabels.slice(0, 10).join(', ')

        const detail = [
          p.narrative_recommendation?.trim() || null,
          laborSummary ? `Labor: ${laborSummary}` : null,
          partsSummary ? `Parts: ${partsSummary}` : null,
        ]
          .filter(Boolean)
          .join(' -- ')
        if (detail) detailByProposalId.set(p.id, detail)
      }
    }

    const outcomeRowsWithDetail = outcomeRows.map((r) => ({
      ...r,
      detail: (r.proposal_id ? detailByProposalId.get(r.proposal_id) : null) ?? r.job_description ?? null,
    }))

    const outcomesContext = buildOutcomesContext(outcomeRowsWithDetail, outcomeScopeLabel)

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

    // IMPORTANT: a technician's flat all-in ask is NOT a pricing target.
    // Clients never see or care what we pay the technician -- they only ever
    // see the final proposal total, and that total has to be defensible on
    // its own, realistic terms. If the proposal were instead reverse-priced
    // to reconcile with whatever the technician asked for, an inflated ask
    // (or a dispatcher testing a number) would blow up every line item into
    // nonsense (e.g. a $25,000 wall panel) and produce a client-facing total
    // no one would ever approve. So the technician's flat quote is only ever
    // used AFTER pricing, as a separate dispatcher-facing comparison (see the
    // pricing-note block near the DB update below) -- never to size or scale
    // the line items themselves.
    const flatQuoteContext = isFlatQuoteMode
      ? `Context: the technician separately told the dispatcher he wants to be paid $${flatQuote} as one flat amount for his own time and effort on this job. This is an internal cost conversation between the dispatcher and the technician -- it is NOT a pricing target, and it must have zero influence on your line items or totals. Price this job exactly the way you would any other: estimate the hours it genuinely needs at the Technician/Helper rates below, and price every part/material at its real, honest, typical U.S. market cost -- never inflated, deflated, or nudged toward any dollar figure to make the total land anywhere in particular. The system will separately show the dispatcher how the technician's $${flatQuote} ask compares to your realistic pricing, so you don't need to reconcile the two.\n\n`
      : ''

    const modeSection = `
${flatQuoteContext}Decide, from the notes (and photos, if present), how many hours of labor this job genuinely needs, and whether it requires a second person (a helper) in addition to the technician. Most small jobs don't need a helper -- only add one when the work truly calls for an extra set of hands (heavy or awkward material, working at height, holding something while the other person works, etc).

Technician/helper hourly rates set by the dispatcher for this job -- use role_name exactly "Technician" for the primary tech's hours and exactly "Helper" for a second person's hours, rather than inventing another role name for them:
- Technician: ${proposal.technician_rate != null ? `$${proposal.technician_rate}/hr` : 'not provided -- still estimate the hours needed; the dispatcher will price it manually'}
- Helper: ${proposal.helper_rate != null ? `$${proposal.helper_rate}/hr` : "not provided -- only add a Helper line item if the job truly needs one, even without a known rate; the dispatcher will price it manually"}

Known labor roles catalog (use one of these exact names instead of "Technician"/"Helper" only if a line item is clearly a different, specialized trade role not covered by the two rates above; if none fit, invent a short clear role name):
${laborList}

Known parts catalog (use the exact name when a line item matches one of these stocked parts):
${partsList}

Parts/materials -- think like an experienced technician in this trade, not a transcriptionist: decide what parts and materials this job actually required based on the work described (trade/subtrade, what was diagnosed, what was done), using the technician's notes as your primary source but not limited only to what they explicitly itemized. If the notes describe a repair or replacement (e.g. "replaced the leaking shutoff valve," "swapped the failed ballast"), infer the specific parts that job realistically consumes even when the technician didn't spell every one out (a valve swap typically also needs fittings/tape/sealant; a ballast swap may need wire nuts; etc.) -- use your trade knowledge, not generic guesses. Create a SEPARATE kind="part" line item for each distinct part you can reasonably identify, with a realistic quantity each. Materials are always a markup-eligible source of margin here (the hourly rate itself is never marked up, in either pricing mode) -- so be thorough rather than sparing: include the ordinary consumables and supporting materials a real job like this would use (fasteners, sealant/adhesive, tape, primer, trim, cleanup/disposal supplies, PPE, etc, as relevant to the trade) at realistic quantities, even when the notes don't spell each one out individually.
Always use kind="part" for a part or material, whether or not it matches the catalog above -- never kind="other" just because it isn't a stocked item. When it doesn't match the catalog, leave part_name blank and instead supply suggested_unit_cost with your best estimate of its cost in USD, before markup, so it still prices out and counts toward the client-facing materials total instead of needing the dispatcher to price it by hand.
Do NOT invent parts the job wouldn't plausibly need, and do NOT pad the list with vague filler ("miscellaneous materials," "misc parts") just to have something there -- thoroughness means naming the real consumables the job would use, not adding line items for their own sake.
If the work described is purely diagnostic/inspection, troubleshooting with no repair performed, a visit where nothing was replaced, or otherwise genuinely required no parts or materials, return ZERO kind="part" line items for this proposal -- never force a parts line onto a job that didn't use any.
This zero-parts rule only applies when nothing actually needs fixing. It is common for a technician's notes to test one specific component (e.g. a sink, a valve, a fixture), find THAT component fine, but also describe separate damage or a problem nearby that still needs correcting (e.g. water damage to a wall, wear on a surface, a failed seal) -- that is NOT a diagnostic-only visit. Whatever corrective work you go on to describe in narrative_recommendation (repairing, replacing, installing, sealing, etc.) must be fully reflected in your line items, with real labor and parts, exactly as if that were the only job -- a clean test result on one part of the system never excuses leaving the rest of the recommended work unpriced.
`.trim()

    const lineItemRules = `- line_items: one per distinct task or material. kind="labor" for people's time (role_name "Technician", "Helper", or a catalog role as described above). kind="part" for any part or material, whether or not it's in the known catalog -- set part_name to the matching catalog name when it matches, and when it doesn't, leave part_name blank and supply suggested_unit_cost instead. kind="other" is only for real non-part, non-labor costs (permits, disposal fees, equipment rental, etc) -- also supply suggested_unit_cost for those.
- quantity is the number of hours (labor) or count/units (part/other).
- Do not include markup, margin, or price in your line items -- only cost-side quantity/role/part. Pricing is computed separately by the system.`

    const contextText = `
You are helping a facilities-maintenance dispatcher turn field technician notes into a client-facing repair/service proposal.

Work order: ${workOrder?.wo ?? proposal.wo}
Store/client: ${proposal.client_name ?? workOrder?.client ?? 'Unknown'}
Trade / Subtrade: ${proposal.trade_name ?? workOrder?.trade ?? 'Unknown'} / ${workOrder?.subtrade ?? 'n/a'}
Location: ${[workOrder?.address, workOrder?.city, workOrder?.state].filter(Boolean).join(', ') || 'Unknown'}
Original issue description: ${workOrder?.description ?? 'n/a'}

Technician field notes:
"""
${proposal.technician_notes}
"""
${imageParts.length ? `\n${imageParts.length} technician photo(s) are attached below for visual context.` : ''}

${modeSection}
${outcomesContext ? `\n${outcomesContext}\n` : ''}
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
        pricing_note: {
          type: 'STRING',
          description:
            'Internal, dispatcher-only note -- never shown to the client. Set this when the past-outcomes history below suggests this price is likely to get pushed back on; otherwise omit it. (Do not use this to comment on the technician\'s flat-quote ask -- the system adds that comparison separately.)',
        },
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
      if (geminiRes.status === 504) {
        return jsonResponse(
          {
            error:
              "The AI took too long to respond -- it may be processing several photos, or Gemini is slow right now. Try again, or remove a photo or two and retry.",
          },
          504,
        )
      }
      const errText = await geminiRes.text()
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
        } else if (li.suggested_unit_cost != null) {
          // Not a stocked catalog part, but the AI estimated its cost -- keep
          // it priced and counted under Parts Cost instead of falling back to
          // needs-manual-pricing with a $0 cost.
          unitCost = Number(li.suggested_unit_cost) || 0
        } else {
          needsManualPricing = true
        }
      } else {
        unitCost = Number(li.suggested_unit_cost) || 0
        needsManualPricing = true
      }

      const unitPrice = priceFor(li.kind, unitCost, markupMult)

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

    // Line items are priced the same way whether or not the technician gave
    // a flat all-in ask: labor at the agreed Technician/Helper rate (never
    // marked up), parts/other at their realistic cost x markup. The
    // technician's flat quote (if any) never scales or reshapes these --
    // see the flatQuoteContext comment above for why, and the dispatcher-
    // facing comparison built further down, near the DB update.
    let lineItemRows = rawLineItemRows

    // Trip Fee / Assessment Fee are fixed amounts the dispatcher enters by
    // hand, separate from the technician's labor/parts cost -- billed to the
    // client at exactly what was entered, with no markup applied.
    if (tripFee > 0) {
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
    if (assessmentFee > 0) {
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

    // Rough "how likely is this to be approved" estimate -- NOT an AI
    // guess (language models are poorly calibrated at stating their own
    // confidence as a number). Instead: look at the N real logged outcomes
    // (within the same client/trade scope already matched above) and report
    // what fraction of the most RELEVANT ones were actually approved.
    // "Relevant" used to mean "closest price" alone -- but price-only
    // matching is blind to scope: a $2,600 wall-repair quote and a $2,600
    // shelving-move quote look identical to a price-only match even though
    // they're nothing alike, so it could rate a small job against unrelated
    // bigger jobs that just happened to cost the same. So this blends two
    // signals -- price closeness, and how similar the job itself reads
    // (word/phrase overlap against each outcome's narrative/parts/labor
    // detail, via jaccardSimilarity above) -- so a same-priced but unrelated
    // job ranks further away than a similarly-scoped job at a different
    // price. Still no external calls, no LLM self-confidence -- a fast,
    // explainable nearest-neighbor over real rows. Needs at least 3 priced
    // outcomes in scope to say anything -- otherwise there's too little to
    // go on.
    const pricedOutcomeRows = outcomeRowsWithDetail.filter((r) => r.total_price != null && !Number.isNaN(Number(r.total_price)))
    let approvalLikelihoodPct: number | null = null
    let approvalLikelihoodBasisN: number | null = null
    let approvalLikelihoodMethod: 'price_and_scope' | 'price_only' | null = null
    if (pricedOutcomeRows.length >= 3 && subtotalPrice > 0) {
      // Build the same kind of "what this job involves" text for the
      // CURRENT proposal that outcomeRowsWithDetail already built for past
      // ones (narrative + labor hours by role + parts list), so both sides
      // of the comparison are the same shape.
      const currentLaborSummary = effectiveLineItems
        .filter((li) => li.kind === 'labor')
        .map((li) => {
          const hrs = li.quantity ?? 1
          return `${li.role_name || 'Labor'} ${round2(hrs)}hr${hrs === 1 ? '' : 's'}`
        })
        .join(', ')
      const currentPartsSummary = effectiveLineItems
        .filter((li) => li.kind === 'part')
        .map((li) => {
          const name = li.part_name || li.description
          const qty = li.quantity ?? 1
          return qty > 1 ? `${name} x${qty}` : name
        })
        .slice(0, 10)
        .join(', ')
      const currentJobText = [
        proposal.technician_notes?.trim() || null,
        draft.narrative_scope?.trim() || null,
        draft.narrative_findings?.trim() || null,
        draft.narrative_recommendation?.trim() || null,
        currentLaborSummary ? `Labor: ${currentLaborSummary}` : null,
        currentPartsSummary ? `Parts: ${currentPartsSummary}` : null,
      ]
        .filter(Boolean)
        .join(' -- ')
      const currentTokens = tokenize(currentJobText)
      const hasEnoughCurrentText = currentTokens.length >= 4

      const k = Math.min(10, pricedOutcomeRows.length)
      const priceDistances = pricedOutcomeRows.map((r) => Math.abs(Number(r.total_price) - subtotalPrice))
      const maxPriceDist = Math.max(...priceDistances, 1)

      let nearest: typeof pricedOutcomeRows
      if (hasEnoughCurrentText) {
        const scored = pricedOutcomeRows.map((r, i) => {
          const priceNorm = priceDistances[i] / maxPriceDist // 0 (same price) .. 1 (furthest in this pool)
          const rowTokens = tokenize(r.detail ?? '')
          // An outcome with too little logged detail to compare scope
          // against is scored neutral (neither penalized nor rewarded)
          // rather than maximally dissimilar, so sparse old manual entries
          // aren't automatically shoved to the bottom.
          const textDissimilarity = rowTokens.length >= 3 ? 1 - jaccardSimilarity(currentTokens, rowTokens) : 0.5
          // Even-weighted on purpose: price still matters (that's the whole
          // point of the estimate) -- scope just stops it from treating an
          // unrelated same-priced job as a good match.
          return { row: r, score: 0.5 * priceNorm + 0.5 * textDissimilarity }
        })
        nearest = scored.sort((a, b) => a.score - b.score).slice(0, k).map((s) => s.row)
        approvalLikelihoodMethod = 'price_and_scope'
      } else {
        // Not enough text on this proposal's own side (bare-bones notes, no
        // AI draft detail) to compare scope against -- fall back to the
        // original price-only match rather than scoring against noise.
        nearest = [...pricedOutcomeRows]
          .sort((a, b) => Math.abs(Number(a.total_price) - subtotalPrice) - Math.abs(Number(b.total_price) - subtotalPrice))
          .slice(0, k)
        approvalLikelihoodMethod = 'price_only'
      }

      const approvedCount = nearest.filter((r) => r.outcome === 'approved').length
      approvalLikelihoodPct = Math.round((approvedCount / k) * 100)
      approvalLikelihoodBasisN = k
    }

    // Dispatcher-facing comparison (computed here, not by the AI, so it's
    // always arithmetically correct): if the technician asked for a flat
    // amount well above what this job realistically costs to do, flag it as
    // its own note rather than letting that gap leak into the client price.
    // Realistic cost = labor + parts/other actually priced above, excluding
    // the pass-through trip/assessment fees (those aren't part of what the
    // technician is asking to be paid for).
    let flatQuoteGapNote: string | null = null
    if (isFlatQuoteMode) {
      const realisticJobCost = round2(subtotalCost - tripFee - assessmentFee)
      if (realisticJobCost > 0 && flatQuote! > realisticJobCost * 1.15 + 50) {
        const overage = round2(flatQuote! - realisticJobCost)
        flatQuoteGapNote = `The technician asked to be paid $${flatQuote} flat for this job, but a realistic labor + materials cost for this scope is only about $${realisticJobCost}. Paying him the full $${flatQuote} would cost roughly $${overage} more than this job is worth -- consider negotiating him down toward $${realisticJobCost}, or budget the difference as a loss on this job. (The proposal above is priced independently of this and is not affected.)`
      }
    }
    // Second backstop, same spirit as the flat-quote comparison above:
    // computed in code, not left to the AI to notice. A part/material that
    // isn't in your verified catalog is priced from the AI's own estimate of
    // typical market cost -- usually fine, but if one estimate comes out
    // unusually large it's worth a dispatcher's eyes before it goes to a
    // client. Catalog-matched parts and labor are excluded (those prices are
    // yours, not a guess); Trip/Assessment Fee lines are added after this
    // point so they're naturally excluded too.
    const OUTLIER_LINE_THRESHOLD = 500
    const estimateOutliers = rawLineItemRows.filter(
      (r) => !r.needs_manual_pricing && r.kind !== 'labor' && r.role_id == null && r.part_id == null && r.quantity * r.unit_cost > OUTLIER_LINE_THRESHOLD,
    )
    const estimateOutlierNote = estimateOutliers.length
      ? `Heads-up: ${estimateOutliers.length === 1 ? 'this line item is' : 'these line items are'} priced from the AI's own market-cost estimate (not your parts catalog) and came out unusually high -- worth a quick check before sending: ${estimateOutliers
          .map((r) => `"${r.description}" ($${round2(r.unit_cost)}/unit x ${r.quantity} = $${round2(r.quantity * r.unit_cost)})`)
          .join(', ')}.`
      : null

    const combinedPricingNote = [flatQuoteGapNote, estimateOutlierNote, draft.pricing_note?.trim() || null].filter(Boolean).join('\n\n') || null

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
        // Dispatcher-only note (never shown to the client) -- cleared on a
        // regenerate that no longer flags an issue, so a stale warning
        // doesn't linger after the job or quote has changed.
        ai_pricing_note: combinedPricingNote,
        approval_likelihood_pct: approvalLikelihoodPct,
        approval_likelihood_basis_n: approvalLikelihoodBasisN,
        approval_likelihood_scope: approvalLikelihoodPct != null ? outcomeScopeLabel : null,
        approval_likelihood_method: approvalLikelihoodMethod,
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

// Three failure modes here, handled differently:
//  - A hung/slow request: Gemini (especially with several photos attached)
//    can simply take a while -- logs show real calls on this project running
//    75-110+ seconds. Supabase kills the whole function uncleanly (an opaque
//    crash, no error of ours to show) past the platform's own hard wall-clock
//    limit, which these logs put at ~150s. So we give Gemini ONE generous,
//    real attempt, timed out well under that 150s ceiling (not the previous
//    25s, which was cutting off calls that would have finished fine) -- that
//    way we control the failure and return a clean, readable error instead
//    of the platform doing it for us. We deliberately do NOT retry a second
//    full-length attempt after a timeout: the job was already slow, a fresh
//    110s attempt on top of the first would risk the request as a whole
//    running past the platform's hard kill again, and it wouldn't fix the
//    underlying slowness anyway.
//  - 503 "high demand": shared free-tier capacity hiccup. These fail fast (no
//    long wait involved), so a short backoff retry is cheap and usually clears it.
//  - 429 "quota exceeded": the free tier allows only a handful of requests
//    PER MINUTE per model. This also fails fast. A fast retry just burns
//    another slot in the same window and gets rejected again -- it only
//    helps to wait roughly as long as Google's own error tells us to (its
//    `retryDelay`), so we do that, once. Anything else (bad request, auth,
//    daily quota gone) fails fast.
const GEMINI_ATTEMPT_TIMEOUT_MS = 110000
const MAX_TRANSIENT_RETRIES = 1

async function callGeminiWithRetry(userParts: unknown[], responseSchema: unknown): Promise<Response> {
  let transientRetries = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GEMINI_ATTEMPT_TIMEOUT_MS)
    let res: Response
    try {
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
          signal: controller.signal,
        },
      )
    } catch {
      // Either our own timeout fired (AbortError) or the connection itself
      // failed. Either way we've already spent most of our time budget, so
      // give up cleanly with a 504 now rather than starting a second
      // full-length attempt that could run the whole invocation past the
      // platform's own hard kill.
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
        const retryInfo = (errBody?.error?.details ?? []).find((d: { ['@type']?: string }) =>
          d['@type']?.includes('RetryInfo'),
        )
        const raw = retryInfo?.retryDelay as string | undefined // e.g. "17s"
        const secs = raw ? parseFloat(raw) : NaN
        if (!Number.isNaN(secs)) delayMs = Math.min(Math.ceil(secs * 1000) + 500, 10000)
      } catch {
        // Couldn't parse it -- fall back to the default delayMs above.
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

// Labor (Technician/Helper hours) bills at exactly the dispatcher's agreed
// rate -- that rate is already what's agreed with the client, so no markup
// goes on top of it, in either hourly or flat-quote mode. Markup only
// applies to parts/materials and other costs, which is where margin comes
// from on these jobs.
function priceFor(kind: 'labor' | 'part' | 'other', cost: number, markupMult: number): number {
  return round2(kind === 'labor' ? cost : cost * markupMult)
}

// Lightweight text-similarity helpers for the approval-likelihood match
// below -- deliberately simple (word + adjacent-word-pair overlap, no
// external NLP/embeddings call) so the estimate stays fast, free, and
// explainable, same spirit as it not being an AI guess. Pasted quote text is
// full of boilerplate ("WO#:", "Following our technician's inspection..."),
// so a decent stopword list matters more here than algorithmic cleverness --
// it's what keeps the comparison on the actual job (valve, drain, shelving,
// wall) instead of the shared template wording every quote repeats.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'was', 'were',
  'be', 'been', 'being', 'this', 'that', 'it', 'its', 'our', 'we', 'he', 'she', 'they', 'at', 'as',
  'by', 'from', 'their', 'will', 'would', 'should', 'could', 'has', 'have', 'had', 'not', 'no', 'all',
  'any', 'also', 'into', 'out', 'up', 'down', 'over', 'under', 'per', 'via', 'due', 'once', 'after',
  'before', 'during', 'upon', 'about', 'than', 'then', 'there', 'here', 'which', 'who', 'what', 'when',
  'where', 'how', 'wo', 'web', 'following', 'technician', 'technicians', 'inspection', 'inspected',
  'determined', 'found', 'existing', 'required', 'requires', 'require', 'repair', 'repaired', 'repairs',
  'replace', 'replaced', 'replacement', 'install', 'installed', 'installation', 'service', 'serviced',
  'incurred', 'trip', 'assessment', 'total', 'billed', 'job', 'work', 'order', 'notes', 'note', 'scope',
  'findings', 'recommend', 'recommended', 'recommendation', 'client', 'store', 'site', 'visit', 'visited',
  'unit', 'units', 'area', 'areas', 'issue', 'issues', 'system', 'labor', 'parts', 'material', 'materials',
])

function tokenize(text: string): string[] {
  const words = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const unigrams = words.filter((w) => w.length > 2 && !STOPWORDS.has(w))
  // Adjacent-word pairs survive even when neither word alone is filtered --
  // gives multi-word terms ("mop sink", "shutoff valve") real weight instead
  // of dissolving into generic single words.
  const bigrams: string[] = []
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i]
    const b = words[i + 1]
    if (a.length <= 2 || b.length <= 2 || (STOPWORDS.has(a) && STOPWORDS.has(b))) continue
    bigrams.push(`${a}_${b}`)
  }
  return [...unigrams, ...bigrams]
}

function jaccardSimilarity(aTokens: string[], bTokens: string[]): number {
  const aSet = new Set(aTokens)
  const bSet = new Set(bTokens)
  if (aSet.size === 0 || bSet.size === 0) return 0
  let intersection = 0
  for (const t of aSet) if (bSet.has(t)) intersection++
  const union = aSet.size + bSet.size - intersection
  return union === 0 ? 0 : intersection / union
}

// Turns labeled real-world quote outcomes (AI Learning tab) into a compact
// prompt paragraph. The client only ever sees the total price on a
// proposal -- never our cost or markup -- so their approve/reject decision
// is driven by that bottom-line number, not by what margin we built into
// it. This leads with the total-price range that tended to get approved
// vs. pushed back (the client-facing signal), with markup kept only as
// secondary, internal-reference context, then a handful of concrete past
// jobs (the real scope/narrative, parts used, and Technician/Helper hours
// for an in-app proposal, or the pasted job_description text for a manual
// entry) so the AI can match a new job's complexity to what level of
// complexity has tended to get approved at what price -- and finally
// actual client feedback quotes, the most concrete signal for what tends
// to get rejected or asked to be revised. Keeps it short on purpose; this
// supplements the AI's judgment, it isn't meant to dominate the prompt.
function buildOutcomesContext(
  rows: Array<{
    trade: string | null
    client: string | null
    total_price: number | null
    markup_pct: number | null
    outcome: string
    client_feedback: string | null
    detail?: string | null
  }>,
  scopeLabel: string,
): string {
  if (!rows.length) return ''

  const approved = rows.filter((r) => r.outcome === 'approved')
  const pushedBack = rows.filter((r) => r.outcome === 'rejected' || r.outcome === 'revision_requested')

  const priceStats = (set: typeof rows) => {
    const priced = set.filter((r) => r.total_price != null && !Number.isNaN(Number(r.total_price)))
    if (!priced.length) return null
    const prices = priced.map((r) => Number(r.total_price))
    return {
      avg: round2(prices.reduce((s, p) => s + p, 0) / prices.length),
      min: round2(Math.min(...prices)),
      max: round2(Math.max(...prices)),
      n: priced.length,
    }
  }
  const approvedPrice = priceStats(approved)
  const pushedBackPrice = priceStats(pushedBack)

  const avgMarkup = (set: typeof rows) => {
    const withMarkup = set.filter((r) => r.markup_pct != null && !Number.isNaN(Number(r.markup_pct)))
    if (!withMarkup.length) return null
    return round2(withMarkup.reduce((s, r) => s + Number(r.markup_pct), 0) / withMarkup.length)
  }
  const approvedAvgMarkup = avgMarkup(approved)
  const pushedBackAvgMarkup = avgMarkup(pushedBack)

  // A handful of concrete past jobs -- real scope/narrative, parts, and
  // labor hours -- so the AI can judge complexity, not just read a price.
  const jobExamples = (set: typeof rows, label: string) =>
    set
      .filter((r) => r.detail && r.detail.trim())
      .slice(0, 3)
      .map((r) => {
        const priceNote = r.total_price != null ? `$${r.total_price}` : 'no price logged'
        return `  - [${label}, ${priceNote}] ${r.detail!.trim().slice(0, 240)}`
      })
  const examples = [...jobExamples(approved, 'Approved'), ...jobExamples(pushedBack, 'Rejected/revised')].join('\n')

  const quotes = pushedBack
    .filter((r) => r.client_feedback && r.client_feedback.trim())
    .slice(0, 6)
    .map((r) => {
      const label = r.outcome === 'rejected' ? 'rejected' : 'asked to revise/lower'
      const priceNote = r.total_price != null ? `, total was $${r.total_price}` : ''
      return `  - "${r.client_feedback!.trim().slice(0, 160)}" (${label}${priceNote})`
    })
    .join('\n')

  return `
Real past outcomes to calibrate against (${scopeLabel}): of ${rows.length} labeled quotes, ${approved.length} were approved and ${pushedBack.length} were rejected or asked to be revised/lowered.
IMPORTANT: the client only ever sees the final total price on the proposal -- never our cost or markup behind it -- so their decision is a reaction to that one number. Treat the price ranges below as the real signal for what this client/trade tends to accept; the markup figures are internal reference only and should not drive your pricing decision.${
    approvedPrice ? ` Approved totals averaged $${approvedPrice.avg} (range $${approvedPrice.min}-$${approvedPrice.max}, n=${approvedPrice.n}).` : ''
  }${
    pushedBackPrice ? ` Rejected/revision-requested totals averaged $${pushedBackPrice.avg} (range $${pushedBackPrice.min}-$${pushedBackPrice.max}, n=${pushedBackPrice.n}).` : ''
  }${
    approvedAvgMarkup != null || pushedBackAvgMarkup != null
      ? ` (Internal reference only, not the client-facing signal: approved markup averaged ${approvedAvgMarkup ?? 'n/a'}%, rejected/revision markup averaged ${pushedBackAvgMarkup ?? 'n/a'}%.)`
      : ''
  }${
    examples ? `\nWhat past jobs like this actually involved (scope, parts, Technician/Helper hours) -- use this to judge how much scope/complexity has tended to earn which price, not just the bare number:\n${examples}` : ''
  }${
    quotes ? `\nWhat clients actually said when they pushed back:\n${quotes}` : ''
  }\nUse this as a sanity check, not a hard rule -- if this job's realistic total would land at or above where this client/trade has tended to get rejected, that's a signal to be more conservative on hours/materials (or flag it via pricing_note) so the total lands closer to what's actually tended to get approved, rather than chasing a markup % the client never sees.
`.trim()
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
