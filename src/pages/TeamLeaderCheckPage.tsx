import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ClipboardCheck, Loader2, Copy, Check, Plus, Trash2, Wand2, Upload, ShieldCheck, Save, X,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { useClients } from '../hooks/useClients'
import { usePriceLists } from '../hooks/usePriceLists'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { PROPOSAL_PRIORITY_OPTIONS, PROPOSAL_STATUS_LABELS } from '../lib/types'
import type { ProposalPriority, ProposalStatus } from '../lib/types'
import { Badge, Button, PageHeader, Panel } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

// (status badge coloring isn't needed here -- the existing-proposal banner
// shows the status as plain text, not a badge, since this page's own focus
// is the AI check, not proposal list styling)

type Severity = 'high' | 'medium' | 'low'
interface CorrectedLineItem {
  kind: 'labor' | 'part' | 'other'
  description: string
  role_name?: string
  quantity: number
  unit_price: number
  changed: boolean
  note: string | null
}
interface ScopeFinding {
  severity: Severity
  category: string
  message: string
}
interface AuditTextResult {
  narrative_scope: string
  narrative_findings: string
  narrative_recommendation: string
  corrected_line_items: CorrectedLineItem[]
  fixes_applied: { category: string; message: string }[]
  scope_findings: ScopeFinding[]
  subtotal_before: number
  subtotal_after: number
  overall_assessment: string
  ai_learning?: { scope_label: string; outcomes_considered: number }
  checked_at: string
}

const SEVERITY_VARIANT: Record<Severity, BadgeVariant> = { high: 'danger', medium: 'warn', low: 'neutral' }
const CATEGORY_LABELS: Record<string, string> = {
  nte: 'NTE',
  scope_mismatch: 'Scope vs. Line Items',
  parts_pricing: 'Parts vs. Price List',
  pricing_risk: 'Pricing vs. History',
  other: 'Other',
}
/** The team leader's one-stop QA gate on a dispatcher's finished proposal --
 *  combines what Breakdown's paste flow does (AI-corrects pricing, tax,
 *  EMG/rate-sheet, equal hours; flags narrative-vs-line-items mismatches for
 *  a human call) with what the Proposal editor does (photos, a saved
 *  record, and -- once the team leader signs off -- an approved proposal
 *  ready to export). Unlike the plain Breakdown paste page, what happens
 *  here IS saved: finalizing creates (or, if one already exists for this
 *  WO, overwrites) a real proposal row with these photos attached, so it
 *  shows up in Proposals/Breakdown and can be exported as a .docx from
 *  there. Only super_admin and data_entry accounts can reach this tab --
 *  the RLS behind proposals only lets a plain dispatcher write their OWN
 *  proposals, so a cross-dispatcher QA tool like this one needs the wider
 *  access those two roles already have. */
export function TeamLeaderCheckPage() {
  const navigate = useNavigate()
  const { activeEntityId, switchableEntities } = useEntityScope()
  const { clients } = useClients()
  const { laborRates } = usePriceLists()
  const { wos } = useWorkOrders()

  const tradeOptions = useMemo(() => {
    const names = laborRates
      .map((r) => r.role_name.replace(/\s*\(EMG\)$/i, '').trim())
      .filter((n) => n.toLowerCase() !== 'helper')
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
  }, [laborRates])

  const dispatcherOptions = useMemo(
    () => Array.from(new Set(wos.map((w) => w.dispatcher?.trim()).filter((v): v is string => Boolean(v)))).sort(),
    [wos],
  )

  const [wo, setWo] = useState('')
  const [dispatcherName, setDispatcherName] = useState('')
  const [clientName, setClientName] = useState('')
  const [tradeName, setTradeName] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [priority, setPriority] = useState<ProposalPriority | ''>('')
  const [nte, setNte] = useState('')
  const [proposalText, setProposalText] = useState('')
  const [autoFilledWo, setAutoFilledWo] = useState('')
  const [matchedEntityId, setMatchedEntityId] = useState<string | null>(null)
  const [existingProposal, setExistingProposal] = useState<{ id: string; version: number; status: ProposalStatus } | null>(null)

  // As soon as the typed WO# matches a real work order, pull its
  // dispatcher/client/trade/city/state/NTE straight in, and separately check
  // whether a proposal already exists for this WO -- if the dispatcher built
  // one in this app before sending it out, finalizing here updates that same
  // record (and its photos/line items) instead of creating a duplicate.
  // Every field stays editable afterward.
  //
  // This looks the WO# up directly (not through the entity-scoped `wos`
  // list above, which only has the currently active entity's work orders)
  // so it finds the WO -- and its OWN entity -- no matter which entity the
  // switcher happens to be on. That entity is what gets checked/saved
  // against below, not whatever the switcher shows.
  useEffect(() => {
    const trimmed = wo.trim()
    if (!trimmed) {
      setAutoFilledWo('')
      setMatchedEntityId(null)
      setExistingProposal(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const [{ data: woData }, { data: propData }] = await Promise.all([
        supabase
          .from('work_orders')
          .select('wo, dispatcher, client, trade, city, state, nte, entity_id')
          .ilike('wo', trimmed)
          .limit(1)
          .maybeSingle(),
        supabase.from('proposals').select('id, version, status').ilike('wo', trimmed).limit(1).maybeSingle(),
      ])
      if (cancelled) return
      if (woData) {
        if (woData.dispatcher) setDispatcherName(woData.dispatcher)
        if (woData.client) setClientName(woData.client)
        if (woData.trade) setTradeName(woData.trade)
        if (woData.city) setCity(woData.city)
        if (woData.state) setState(woData.state)
        if (woData.nte != null) setNte(String(woData.nte))
        setAutoFilledWo(woData.wo)
        setMatchedEntityId(woData.entity_id ?? null)
      }
      setExistingProposal((propData as { id: string; version: number; status: ProposalStatus } | null) ?? null)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [wo])

  const matchedEntityName = useMemo(
    () => (matchedEntityId ? switchableEntities.find((e) => e.id === matchedEntityId)?.name : undefined),
    [matchedEntityId, switchableEntities],
  )

  // Job photos, staged locally as files -- nothing uploads to storage until
  // the team leader finalizes below, same "nothing happens until you act"
  // spirit as the rest of this check.
  const [photos, setPhotos] = useState<File[]>([])
  const photoPreviews = useMemo(() => photos.map((file) => ({ file, url: URL.createObjectURL(file) })), [photos])
  useEffect(() => {
    return () => {
      photoPreviews.forEach((p) => URL.revokeObjectURL(p.url))
    }
  }, [photoPreviews])
  const addPhotos = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setPhotos((prev) => [...prev, ...Array.from(files)])
  }
  const removePhoto = (i: number) => {
    setPhotos((prev) => prev.filter((_, idx) => idx !== i))
  }

  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AuditTextResult | null>(null)
  const [copied, setCopied] = useState(false)

  // The narrative/pricing scope check (scope-vs-narrative, parts-vs-price-
  // list, pricing-vs-history) runs as its OWN AI call, fired right after
  // Check & Fix or Apply Edit returns, instead of being part of that
  // response -- so the corrected breakdown above shows up as soon as the
  // faster of the two AI calls finishes, and this slower one fills in the
  // findings below a few seconds later instead of blocking the whole page.
  const [scopeChecking, setScopeChecking] = useState(false)
  const [scopeCheckError, setScopeCheckError] = useState('')

  const runScopeCheck = async (input: {
    entityId: string | null
    narrativeScope: string
    narrativeFindings: string
    narrativeRecommendation: string
    items: CorrectedLineItem[]
  }) => {
    setScopeChecking(true)
    setScopeCheckError('')
    try {
      const { data, error: err } = await supabase.functions.invoke('check-breakdown-scope', {
        body: {
          entity_id: input.entityId,
          wo: wo.trim() || null,
          client_name: clientName.trim() || null,
          trade_name: tradeName.trim() || null,
          nte: nte.trim() ? Number(nte) : null,
          narrative_scope: input.narrativeScope,
          narrative_findings: input.narrativeFindings,
          narrative_recommendation: input.narrativeRecommendation,
          line_items: input.items.map(({ kind, description, role_name, quantity, unit_price }) => ({ kind, description, role_name, quantity, unit_price })),
        },
      })
      if (err) {
        let message = err.message
        try {
          const ctx = (err as unknown as { context?: Response }).context
          if (ctx) {
            const body = await ctx.clone().json()
            if (body?.error) message = body.error
          }
        } catch {
          // fall back to err.message
        }
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      setResult((prev) =>
        prev
          ? {
              ...prev,
              scope_findings: [...prev.scope_findings, ...(data.scope_findings ?? [])],
              overall_assessment: data.overall_assessment || prev.overall_assessment,
              ai_learning: data.ai_learning,
            }
          : prev,
      )
    } catch (e) {
      setScopeCheckError((e as Error).message)
    } finally {
      setScopeChecking(false)
    }
  }

  // The narrative and line items shown below are editable copies of the
  // last check/edit result -- hand edits here are purely local until either
  // the team leader asks the AI to apply a change (which replaces `result`,
  // and these, with a fresh response) or finalizes below.
  const [editableScope, setEditableScope] = useState('')
  const [editableFindings, setEditableFindings] = useState('')
  const [editableRecommendation, setEditableRecommendation] = useState('')
  const [editableItems, setEditableItems] = useState<CorrectedLineItem[]>([])

  useEffect(() => {
    if (!result) return
    setEditableScope(result.narrative_scope)
    setEditableFindings(result.narrative_findings)
    setEditableRecommendation(result.narrative_recommendation)
    setEditableItems(result.corrected_line_items)
  }, [result])

  const editableTotal = useMemo(() => editableItems.reduce((s, li) => s + li.quantity * li.unit_price, 0), [editableItems])
  const nteNum = nte.trim() ? Number(nte) : null

  const updateItem = (i: number, patch: Partial<CorrectedLineItem>) => {
    setEditableItems((items) => items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  const removeItem = (i: number) => {
    setEditableItems((items) => items.filter((_, idx) => idx !== i))
  }
  const addItem = () => {
    setEditableItems((items) => [...items, { kind: 'other', description: '', role_name: undefined, quantity: 1, unit_price: 0, changed: false, note: null }])
  }

  const [editInstruction, setEditInstruction] = useState('')
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState('')

  const handleApplyEdit = async () => {
    if (!editInstruction.trim()) {
      setEditError('Describe what to change first.')
      return
    }
    setEditing(true)
    setEditError('')
    setScopeCheckError('')
    try {
      const { data, error: err } = await supabase.functions.invoke('edit-proposal-breakdown', {
        body: {
          entity_id: matchedEntityId ?? activeEntityId,
          wo: wo.trim() || null,
          client_name: clientName.trim() || null,
          trade_name: tradeName.trim() || null,
          city: city.trim() || null,
          state: state.trim() || null,
          priority: priority || null,
          nte: nte.trim() ? Number(nte) : null,
          narrative_scope: editableScope,
          narrative_findings: editableFindings,
          narrative_recommendation: editableRecommendation,
          line_items: editableItems.map(({ kind, description, role_name, quantity, unit_price }) => ({ kind, description, role_name, quantity, unit_price })),
          instruction: editInstruction,
        },
      })
      if (err) {
        let message = err.message
        try {
          const ctx = (err as unknown as { context?: Response }).context
          if (ctx) {
            const body = await ctx.clone().json()
            if (body?.error) message = body.error
          }
        } catch {
          // fall back to err.message
        }
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      const editResult = data as AuditTextResult
      setResult(editResult)
      setEditInstruction('')
      setCopied(false)
      runScopeCheck({
        entityId: matchedEntityId ?? activeEntityId,
        narrativeScope: editResult.narrative_scope,
        narrativeFindings: editResult.narrative_findings,
        narrativeRecommendation: editResult.narrative_recommendation,
        items: editResult.corrected_line_items,
      })
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setEditing(false)
    }
  }

  const handleCheck = async () => {
    if (!proposalText.trim()) {
      setError('Paste the proposal text first.')
      return
    }
    setChecking(true)
    setError('')
    setResult(null)
    setCopied(false)
    setScopeCheckError('')
    try {
      const { data, error: err } = await supabase.functions.invoke('audit-proposal-text', {
        body: {
          entity_id: matchedEntityId ?? activeEntityId,
          wo: wo.trim() || null,
          client_name: clientName.trim() || null,
          trade_name: tradeName.trim() || null,
          city: city.trim() || null,
          state: state.trim() || null,
          priority: priority || null,
          nte: nte.trim() ? Number(nte) : null,
          proposal_text: proposalText,
        },
      })
      if (err) {
        let message = err.message
        try {
          const ctx = (err as unknown as { context?: Response }).context
          if (ctx) {
            const body = await ctx.clone().json()
            if (body?.error) message = body.error
          }
        } catch {
          // fall back to err.message
        }
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      const checkResult = data as AuditTextResult
      setResult(checkResult)
      runScopeCheck({
        entityId: matchedEntityId ?? activeEntityId,
        narrativeScope: checkResult.narrative_scope,
        narrativeFindings: checkResult.narrative_findings,
        narrativeRecommendation: checkResult.narrative_recommendation,
        items: checkResult.corrected_line_items,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const copyText = () => {
    if (!result) return
    const round2 = (n: number) => Math.round(n * 100) / 100
    const fmt = (n: number) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const DASH = '-'.repeat(70)
    const isTrip = (li: CorrectedLineItem) => /trip/i.test(li.role_name || '') || /trip/i.test(li.description || '')
    const isAssessment = (li: CorrectedLineItem) => /assess/i.test(li.role_name || '') || /assess/i.test(li.description || '')
    const isHelper = (li: CorrectedLineItem) => /helper/i.test(li.role_name || '') || /helper/i.test(li.description || '')
    const isTax = (li: CorrectedLineItem) => li.kind === 'other' && /sales tax/i.test(li.description || '')

    const incurred = editableItems.filter((li) => isTrip(li) || isAssessment(li))
    const laborOther = editableItems.filter((li) => li.kind === 'labor' && !isTrip(li) && !isAssessment(li))
    const parts = editableItems.filter((li) => li.kind === 'part')
    const taxLine = editableItems.find(isTax)
    const otherMisc = editableItems.filter((li) => li.kind === 'other' && li !== taxLine)

    const lines: string[] = []
    lines.push(`WO#: ${wo.trim() || '(not set)'}`, DASH)
    lines.push(editableScope || '')
    if (editableFindings) lines.push('', 'Findings:', editableFindings)
    if (editableRecommendation) lines.push('', 'Recommendation:', editableRecommendation)
    lines.push(DASH)

    if (incurred.length > 0) {
      lines.push('Incurred:', '')
      let incurredTotal = 0
      for (const li of incurred) {
        const total = li.quantity * li.unit_price
        incurredTotal += total
        lines.push(`  ${isTrip(li) ? 'Trip' : 'Assessment'}: ${fmt(total)}`)
      }
      lines.push('', `  Total: ${fmt(incurredTotal)}`, DASH)
    }

    if (laborOther.length > 0) {
      lines.push('Labor:', '', 'Day 1', '')
      const groups = new Map<string, { quantity: number; unit_price: number; helper: boolean; count: number }>()
      for (const li of laborOther) {
        const helper = isHelper(li)
        const key = `${helper}|${li.quantity}|${li.unit_price}`
        const g = groups.get(key)
        if (g) g.count += 1
        else groups.set(key, { quantity: li.quantity, unit_price: li.unit_price, helper, count: 1 })
      }
      let laborTotal = 0
      for (const g of groups.values()) {
        const total = g.count * g.quantity * g.unit_price
        laborTotal += total
        const roleWord = g.helper ? (g.count === 1 ? 'helper' : 'helpers') : g.count === 1 ? 'tech' : 'techs'
        lines.push(`${g.quantity} hours labor ${g.count} ${roleWord}: ${fmt(total)}`)
      }
      lines.push('', `Labor Total: ${fmt(laborTotal)}`, DASH)
    }

    if (parts.length > 0) {
      lines.push('Parts & Materials:', '')
      let partsTotal = 0
      for (const li of parts) {
        const total = li.quantity * li.unit_price
        partsTotal += total
        lines.push(`- ${li.description} x${li.quantity}: ${fmt(total)}`)
      }
      lines.push('', ` Total Parts & Materials: ${fmt(partsTotal)}`, DASH)
    }

    if (otherMisc.length > 0) {
      lines.push('Other:', '')
      let otherTotal = 0
      for (const li of otherMisc) {
        const total = li.quantity * li.unit_price
        otherTotal += total
        lines.push(`- ${li.description}: ${fmt(total)}`)
      }
      lines.push('', `Other Total: ${fmt(otherTotal)}`, DASH)
    }

    const taxAmount = taxLine ? taxLine.quantity * taxLine.unit_price : 0
    const subtotal = editableTotal - taxAmount
    lines.push(`Subtotal: ${fmt(subtotal)}`)
    if (taxLine) {
      const pct = subtotal > 0 ? (taxAmount / subtotal) * 100 : 0
      lines.push(`Tax (${pct.toFixed(2)}%): ${fmt(taxAmount)}`)
    }
    lines.push(DASH, `GRAND TOTAL: ${fmt(editableTotal)}`)

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Finalizing is the whole point of this tab over the plain Breakdown
  // paste page: it actually creates (or overwrites, if one already exists
  // for this WO) a real proposal row with these corrected line items and
  // photos attached, so it becomes the proposal everyone else in the app
  // sees -- in Proposals, in Breakdown, and exportable as a .docx from the
  // editor it lands on afterward.
  const [saving, setSaving] = useState<'in_review' | 'approved' | null>(null)
  const [saveError, setSaveError] = useState('')

  const handleSave = async (targetStatus: 'in_review' | 'approved') => {
    setSaveError('')
    if (!result) {
      setSaveError('Run Check & Fix first.')
      return
    }
    if (!wo.trim()) {
      setSaveError('Enter the work order number.')
      return
    }
    if (photos.length === 0) {
      setSaveError('Attach at least one photo of the completed job.')
      return
    }
    setSaving(targetStatus)
    try {
      const entityId = matchedEntityId ?? activeEntityId
      const { data: userData } = await supabase.auth.getUser()
      const userId = userData?.user?.id ?? null

      const baseFields = {
        wo: wo.trim(),
        dispatcher_name: dispatcherName.trim() || null,
        client_name: clientName.trim() || null,
        trade_name: tradeName.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        priority: priority || null,
        nte: nte.trim() ? Number(nte) : null,
        narrative_scope: editableScope || null,
        narrative_findings: editableFindings || null,
        narrative_recommendation: editableRecommendation || null,
        subtotal_price: editableTotal,
        // Pasted proposals don't carry a per-line cost breakdown (just the
        // client-facing price), so cost/margin are left unset here rather
        // than guessed -- same gap the Breakdown paste check already has.
        subtotal_cost: 0,
        margin_pct: null,
        status: targetStatus,
        ...(targetStatus === 'approved' ? { approved_at: new Date().toISOString() } : {}),
      }

      let proposalId: string
      if (existingProposal) {
        const { error: updErr } = await supabase.from('proposals').update(baseFields).eq('id', existingProposal.id)
        if (updErr) throw updErr
        proposalId = existingProposal.id
        const { error: delErr } = await supabase.from('proposal_line_items').delete().eq('proposal_id', proposalId)
        if (delErr) throw delErr
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from('proposals')
          .insert({ ...baseFields, entity_id: entityId, created_by: userId })
          .select('id')
          .single()
        if (insErr) throw insErr
        proposalId = (inserted as { id: string }).id
      }

      if (editableItems.length > 0) {
        const { error: liErr } = await supabase.from('proposal_line_items').insert(
          editableItems.map((li, i) => ({
            proposal_id: proposalId,
            kind: li.kind,
            description: li.description || '(no description)',
            quantity: li.quantity,
            unit_cost: 0,
            unit_price: li.unit_price,
            needs_manual_pricing: false,
            ai_suggested: false,
            sort_order: i,
          })),
        )
        if (liErr) throw liErr
      }

      // Keep new photos after any that already exist on this proposal
      // (only relevant when overwriting an existing one) instead of
      // resetting the ordering to 0 and jumbling them.
      const { count: existingPhotoCount } = await supabase
        .from('proposal_photos')
        .select('id', { count: 'exact', head: true })
        .eq('proposal_id', proposalId)
      let nextOrder = existingPhotoCount ?? 0
      for (const file of photos) {
        const ext = file.name.split('.').pop() || 'jpg'
        const path = `${proposalId}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('proposal-photos').upload(path, file)
        if (upErr) throw upErr
        const { error: phErr } = await supabase.from('proposal_photos').insert({
          proposal_id: proposalId,
          storage_path: path,
          uploaded_by: userId,
          sort_order: nextOrder,
        })
        if (phErr) throw phErr
        nextOrder += 1
      }

      navigate(`/proposals/${proposalId}`)
    } catch (e) {
      setSaveError((e as Error).message)
      setSaving(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proposal Team Leader Check"
        description="Paste the proposal the dispatcher wrote and add photos of the finished job. The AI checks and fixes pricing, tax, and rate-sheet mistakes the same way Breakdown does -- then, once it looks right, save it here to turn it into the real, final proposal with the photos attached."
      />

      <Panel className="p-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-sm font-bold text-ink">Work Order #</label>
            <input
              type="text"
              list="tl-wos"
              value={wo}
              onChange={(e) => setWo(e.target.value)}
              placeholder="WO #"
              className="field mt-1 w-full"
            />
            <datalist id="tl-wos">
              {wos.map((w) => (
                <option key={w.wo} value={w.wo} />
              ))}
            </datalist>
            {autoFilledWo && (
              <p className="text-xs text-good mt-1">
                Found WO {autoFilledWo}{matchedEntityName ? ` (${matchedEntityName})` : ''} -- dispatcher/client/trade/city/state/NTE filled in below. Edit any field if it's wrong.
              </p>
            )}
            {existingProposal && (
              <p className="text-xs text-warn mt-1">
                A proposal already exists for this WO (v{existingProposal.version}, {PROPOSAL_STATUS_LABELS[existingProposal.status]}) -- saving below will overwrite its narrative, line items, and status, and add these photos to it rather than creating a duplicate.
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Dispatcher</label>
            <input
              type="text"
              list="tl-dispatchers"
              value={dispatcherName}
              onChange={(e) => setDispatcherName(e.target.value)}
              placeholder="Who wrote this proposal"
              className="field mt-1 w-full"
            />
            <datalist id="tl-dispatchers">
              {dispatcherOptions.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Client</label>
            <input
              type="text"
              list="tl-clients"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="e.g. O'Reilly"
              className="field mt-1 w-full"
            />
            <datalist id="tl-clients">
              {clients.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Trade</label>
            <input
              type="text"
              list="tl-trades"
              value={tradeName}
              onChange={(e) => setTradeName(e.target.value)}
              placeholder="e.g. Plumber"
              className="field mt-1 w-full"
            />
            <datalist id="tl-trades">
              {tradeOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">City</label>
            <input type="text" value={city} onChange={(e) => setCity(e.target.value)} className="field mt-1 w-full" />
          </div>
          <div>
            <label className="text-sm font-bold text-ink">State</label>
            <input type="text" value={state} onChange={(e) => setState(e.target.value)} placeholder="2-letter, e.g. TX" maxLength={2} className="field mt-1 w-full" />
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as ProposalPriority)} className="field mt-1 w-full">
              <option value="">(none)</option>
              {PROPOSAL_PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">NTE ($)</label>
            <input
              type="number"
              inputMode="decimal"
              value={nte}
              onChange={(e) => setNte(e.target.value)}
              placeholder="Client's Not-To-Exceed"
              className="field mt-1 w-full"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-bold text-ink">Job Photos</label>
            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:text-brand-800 cursor-pointer">
              <Upload size={13} /> Add photos
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addPhotos(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
          {photos.length === 0 && <p className="text-xs text-ink-faint">No photos yet -- add at least one of the finished job before saving.</p>}
          <div className="flex flex-wrap gap-3">
            {photoPreviews.map((p, i) => (
              <div key={p.url} className="relative group">
                <img src={p.url} alt={p.file.name} className="w-24 h-24 object-cover rounded-lg border border-line" />
                <button
                  onClick={() => removePhoto(i)}
                  className="absolute -top-1.5 -right-1.5 bg-white border border-line rounded-full p-1 text-ink-faint hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm font-bold text-ink">Proposal (narrative + pricing breakdown)</label>
          <textarea
            value={proposalText}
            onChange={(e) => setProposalText(e.target.value)}
            placeholder="Paste the dispatcher's full proposal here -- scope of work, findings, recommendation, and the line items with their prices..."
            rows={10}
            className="field mt-1 w-full font-mono text-xs"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          variant="primary"
          icon={checking ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
          disabled={checking}
          onClick={handleCheck}
        >
          {checking ? 'Checking...' : 'Check & Fix'}
        </Button>
      </Panel>

      {result && (
        <>
          <Panel className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-ink">Corrected Breakdown</p>
              <Button variant="secondary" size="sm" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copyText}>
                {copied ? 'Copied' : 'Copy as text'}
              </Button>
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-xs font-semibold text-ink-faint">Scope of Work</label>
                <textarea
                  value={editableScope}
                  onChange={(e) => setEditableScope(e.target.value)}
                  rows={3}
                  className="field mt-1 w-full text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-faint">Findings</label>
                <textarea
                  value={editableFindings}
                  onChange={(e) => setEditableFindings(e.target.value)}
                  rows={2}
                  placeholder="(none)"
                  className="field mt-1 w-full text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-faint">Recommendation</label>
                <textarea
                  value={editableRecommendation}
                  onChange={(e) => setEditableRecommendation(e.target.value)}
                  rows={2}
                  placeholder="(none)"
                  className="field mt-1 w-full text-sm"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="table-head-row">
                    <th className="px-2 py-2 text-left">Kind</th>
                    <th className="px-2 py-2">Description</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Unit Price</th>
                    <th className="px-4 py-2 text-right">Total</th>
                    <th className="px-2 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {editableItems.map((li, i) => (
                    <tr key={i} className="table-row align-top">
                      <td className="px-2 py-2.5">
                        <select
                          value={li.kind}
                          onChange={(e) => updateItem(i, { kind: e.target.value as CorrectedLineItem['kind'] })}
                          className="field text-xs"
                        >
                          <option value="labor">Labor</option>
                          <option value="part">Part</option>
                          <option value="other">Other</option>
                        </select>
                      </td>
                      <td className="px-2 py-2.5 text-ink">
                        <input
                          type="text"
                          value={li.description}
                          onChange={(e) => updateItem(i, { description: e.target.value })}
                          className="field w-full"
                        />
                        {li.changed && <Badge variant="brand">Fixed</Badge>}
                        {li.changed && li.note && <p className="text-xs text-ink-faint mt-0.5">{li.note}</p>}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <input
                          type="number"
                          value={li.quantity}
                          onChange={(e) => updateItem(i, { quantity: Number(e.target.value) || 0 })}
                          className="field w-16 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={li.unit_price}
                          onChange={(e) => updateItem(i, { unit_price: Number(e.target.value) || 0 })}
                          className="field w-24 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink tabular-nums">${(li.quantity * li.unit_price).toFixed(2)}</td>
                      <td className="px-2 py-2.5 text-right">
                        <button type="button" onClick={() => removeItem(i)} className="text-ink-faint hover:text-danger" title="Remove line">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="px-4 py-2.5 text-right font-bold text-ink">Total</td>
                    <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">${editableTotal.toFixed(2)}</td>
                    <td />
                  </tr>
                  {nteNum != null && nteNum > 0 && editableTotal > nteNum + 0.01 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-1 text-right text-xs text-danger">
                        Over the ${nteNum.toFixed(2)} NTE by ${(editableTotal - nteNum).toFixed(2)}
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>

            <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={addItem}>
              Add line
            </Button>
          </Panel>

          {result.fixes_applied.length > 0 && (
            <Panel className="p-4 space-y-2">
              <p className="text-sm font-bold text-ink">What we fixed</p>
              <ul className="space-y-1.5">
                {result.fixes_applied.map((f, i) => (
                  <li key={i} className="text-sm text-ink-soft flex items-start gap-2">
                    <Check size={15} className="shrink-0 mt-0.5 text-good" />
                    {f.message}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel className="p-4 space-y-2">
            <p className="text-sm font-bold text-ink">Still needs your review</p>
            {result.overall_assessment && <p className="text-sm text-ink-soft italic">{result.overall_assessment}</p>}
            {result.scope_findings.length > 0 && (
              <ul className="space-y-2">
                {result.scope_findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 rounded-lg border border-line bg-canvas p-3">
                    <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity.toUpperCase()}</Badge>
                    <div className="space-y-0.5 flex-1">
                      <span className="text-xs font-semibold text-ink-faint">{CATEGORY_LABELS[f.category] ?? f.category}</span>
                      <p className="text-sm text-ink">{f.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {scopeChecking && (
              <p className="text-sm text-ink-faint flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Checking the narrative, parts pricing, and past outcomes...
              </p>
            )}
            {!scopeChecking && scopeCheckError && (
              <p className="text-sm text-danger">Couldn't finish that check -- {scopeCheckError}</p>
            )}
            {!scopeChecking && !scopeCheckError && result.scope_findings.length === 0 && (
              <p className="text-sm text-good">Narrative and line items look consistent.</p>
            )}
            {result.ai_learning && result.ai_learning.outcomes_considered > 0 && (
              <p className="text-xs text-ink-faint">
                Checked against {result.ai_learning.outcomes_considered} historical AI Learning outcomes ({result.ai_learning.scope_label}).
              </p>
            )}
          </Panel>

          <Panel className="p-4 space-y-2">
            <p className="text-sm font-bold text-ink">Ask AI to edit this breakdown</p>
            <p className="text-xs text-ink-faint">
              Describe a change in plain language -- e.g. "add a $50 disposal fee", "the narrative should say the door was replaced, not repaired", "remove the Assessment Fee line". Only what you ask for changes; nothing else is re-priced or corrected.
            </p>
            <textarea
              value={editInstruction}
              onChange={(e) => setEditInstruction(e.target.value)}
              placeholder="What should change?"
              rows={2}
              className="field w-full text-sm"
            />
            {editError && <p className="text-sm text-danger">{editError}</p>}
            <Button
              variant="primary"
              size="sm"
              icon={editing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              disabled={editing}
              onClick={handleApplyEdit}
            >
              {editing ? 'Applying...' : 'Apply Edit'}
            </Button>
          </Panel>

          <Panel className="p-4 space-y-3">
            <p className="text-sm font-bold text-ink">Finalize</p>
            <p className="text-xs text-ink-faint">
              Once this looks right, save it. "Save as Draft" keeps it in review for someone else to finish; "Approve & Save" marks it approved and ready to send. Either way this becomes the real proposal for WO {wo.trim() || '…'} -- with these {photos.length} photo{photos.length === 1 ? '' : 's'} attached -- and opens in the Proposal Editor so you can double-check it or export the .docx.
            </p>
            {saveError && <p className="text-sm text-danger">{saveError}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={saving === 'in_review' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                disabled={saving !== null}
                onClick={() => handleSave('in_review')}
              >
                {saving === 'in_review' ? 'Saving...' : 'Save as Draft'}
              </Button>
              <Button
                variant="primary"
                icon={saving === 'approved' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                disabled={saving !== null}
                onClick={() => handleSave('approved')}
              >
                {saving === 'approved' ? 'Saving...' : 'Approve & Save'}
              </Button>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
