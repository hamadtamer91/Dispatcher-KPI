import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, Gauge, Plus, Send, Sparkles, Trash2, Upload } from 'lucide-react'
import { useProposalDetail } from '../hooks/useProposalDetail'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useQuoteOutcomes } from '../hooks/useQuoteOutcomes'
import { exportProposalDocx } from '../lib/exportProposalDocx'
import { PROPOSAL_STATUS_LABELS, QUOTE_OUTCOME_LABELS } from '../lib/types'
import type { LineItemKind, ProposalLineItem, ProposalStatus, QuoteOutcomeResult } from '../lib/types'
import { Badge, Button } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const STATUS_VARIANT: Record<ProposalStatus, BadgeVariant> = {
  draft: 'neutral',
  ai_generated: 'brand',
  in_review: 'warn',
  approved: 'good',
  sent: 'good',
}

// Margin % and Markup % are different numbers: at a given Markup %, the
// highest margin a proposal can ever mathematically reach is
// markup / (1 + markup) -- at the default 75% markup that's ~42.9%, even on
// a job that's 100% parts/materials, since margin asymptotically approaches
// 100% only as markup goes to infinity. 50% would need ~100% markup to even
// be reachable, so the floor is set below that ceiling instead of above it.
const MARGIN_FLOOR_PCT = 35

export function ProposalDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const {
    proposal,
    lineItems,
    photos,
    loading,
    error,
    generating,
    updateProposal,
    addLineItem,
    updateLineItem,
    deleteLineItem,
    uploadPhoto,
    deletePhoto,
    photoUrl,
    generateDraft,
  } = useProposalDetail(id)
  const { wos } = useWorkOrders()
  const { outcomes, recordProposalOutcome } = useQuoteOutcomes()

  const [notes, setNotes] = useState('')
  const [clientName, setClientName] = useState('')
  const [technicianRate, setTechnicianRate] = useState('')
  const [helperRate, setHelperRate] = useState('')
  const [flatQuote, setFlatQuote] = useState('')
  const [tripFee, setTripFee] = useState('')
  const [assessmentFee, setAssessmentFee] = useState('')
  const [markupPct, setMarkupPct] = useState('75')
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [genError, setGenError] = useState('')

  useEffect(() => {
    if (proposal) {
      setNotes(proposal.technician_notes ?? '')
      setClientName(proposal.client_name ?? '')
      setTechnicianRate(proposal.technician_rate != null ? String(proposal.technician_rate) : '')
      setHelperRate(proposal.helper_rate != null ? String(proposal.helper_rate) : '')
      setFlatQuote(proposal.technician_flat_quote != null ? String(proposal.technician_flat_quote) : '')
      setTripFee(proposal.trip_fee != null ? String(proposal.trip_fee) : '')
      setAssessmentFee(proposal.assessment_fee != null ? String(proposal.assessment_fee) : '')
      setMarkupPct(String(proposal.markup_pct))
    }
  }, [
    proposal?.id,
    proposal?.technician_notes,
    proposal?.client_name,
    proposal?.technician_rate,
    proposal?.helper_rate,
    proposal?.technician_flat_quote,
    proposal?.trip_fee,
    proposal?.assessment_fee,
    proposal?.markup_pct,
  ])

  useEffect(() => {
    let active = true
    Promise.all(photos.map(async (p) => [p.id, await photoUrl(p.storage_path)] as const)).then((pairs) => {
      if (!active) return
      setPhotoUrls(Object.fromEntries(pairs))
    })
    return () => {
      active = false
    }
  }, [photos, photoUrl])

  const workOrder = useMemo(() => wos.find((w) => w.wo === proposal?.wo), [wos, proposal?.wo])

  const isLocked = proposal?.status === 'approved' || proposal?.status === 'sent'
  const isFlatQuoteMode = proposal?.technician_flat_quote != null && Number(proposal.technician_flat_quote) > 0

  const subtotalPrice = lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0)
  const technicianCost = lineItems.filter((li) => li.kind === 'labor').reduce((s, li) => s + li.quantity * li.unit_cost, 0)
  const partsCost = lineItems.filter((li) => li.kind === 'part').reduce((s, li) => s + li.quantity * li.unit_cost, 0)
  const otherCost = lineItems.filter((li) => li.kind === 'other').reduce((s, li) => s + li.quantity * li.unit_cost, 0)
  const subtotalCost = technicianCost + partsCost + otherCost
  const marginPct = subtotalPrice > 0 ? ((subtotalPrice - subtotalCost) / subtotalPrice) * 100 : 0
  const belowFloor = subtotalPrice > 0 && marginPct < MARGIN_FLOOR_PCT
  const needsManual = lineItems.some((li) => li.needs_manual_pricing)
  // In flat-quote mode, "Technician Cost" above is an ALLOCATION of the flat
  // payout across lines (for bookkeeping), not a literal per-hour cost -- the
  // technician is paid proposal.technician_flat_quote no matter how the hours
  // break down, so that's the honest number to show instead.
  const flatCostDisplay = isFlatQuoteMode ? Number(proposal!.technician_flat_quote) : technicianCost

  if (loading) return <p className="text-sm text-ink-faint py-8 text-center">Loading proposal...</p>
  if (!proposal) return <p className="text-sm text-danger">{error || 'Proposal not found.'}</p>

  const handleGenerate = async () => {
    setGenError('')
    try {
      await updateProposal({
        technician_notes: notes,
        client_name: clientName.trim() || null,
        technician_rate: technicianRate.trim() ? Number(technicianRate) : null,
        helper_rate: helperRate.trim() ? Number(helperRate) : null,
        technician_flat_quote: flatQuote.trim() ? Number(flatQuote) : null,
      })
      await generateDraft()
    } catch (e) {
      setGenError((e as Error).message)
    }
  }

  const handleAddLineItem = async (kind: LineItemKind) => {
    await addLineItem({ kind, description: '', quantity: 1, unit_cost: 0, unit_price: 0 })
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const blob = await exportProposalDocx(proposal, lineItems)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Proposal_${proposal.wo}_v${proposal.version}.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('/proposals')}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-ink transition-colors"
      >
        <ArrowLeft size={14} /> Back to Proposals
      </button>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-extrabold text-ink tracking-tight">Proposal — WO {proposal.wo}</h2>
          <p className="text-sm text-ink-soft mt-1">
            {proposal.client_name || workOrder?.client || 'Unassigned store'} · {workOrder?.trade || 'n/a'} · v{proposal.version}
          </p>
        </div>
        <Badge variant={STATUS_VARIANT[proposal.status]}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Badge>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {genError && <p className="text-sm text-danger bg-danger-tint border border-danger/20 rounded-lg p-3">{genError}</p>}

      <div className="panel p-5 space-y-4">
        <div>
          <label className="text-sm font-bold text-ink">Client Name</label>
          <input
            type="text"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            onBlur={() => updateProposal({ client_name: clientName.trim() || null })}
            disabled={isLocked}
            placeholder={workOrder?.client ? `Defaults to "${workOrder.client}" from the work order` : 'e.g. CBRE -- Store #1234'}
            className="field mt-1"
          />
          <p className="text-xs text-ink-faint mt-1">
            Tells the AI who this proposal is for. Leave blank to use the work order's client automatically.
          </p>
        </div>

        <div>
          <label className="text-sm font-bold text-ink">Technician Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => updateProposal({ technician_notes: notes })}
            disabled={isLocked}
            rows={5}
            className="field mt-1"
            placeholder="What did the technician find and do on site?"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-bold text-ink">Technician Rate ($/hr)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={technicianRate}
              onChange={(e) => setTechnicianRate(e.target.value)}
              onBlur={() => updateProposal({ technician_rate: technicianRate.trim() ? Number(technicianRate) : null })}
              disabled={isLocked}
              placeholder="e.g. 45"
              className="field mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Helper Rate ($/hr)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={helperRate}
              onChange={(e) => setHelperRate(e.target.value)}
              onBlur={() => updateProposal({ helper_rate: helperRate.trim() ? Number(helperRate) : null })}
              disabled={isLocked}
              placeholder="Leave blank if no helper"
              className="field mt-1"
            />
          </div>
          <p className="sm:col-span-2 text-xs text-ink-faint">
            The AI decides the hours needed and whether a helper is required from the notes and photos, then fills in the breakdown as
            labor/part rows below. These rates themselves are never marked up — they bill at exactly what you enter, since that's what's
            agreed with the client. On an hourly job, margin comes only from parts/materials, so make sure Markup % covers it there. On a
            flat-quote job, the hours/helper the AI chooses also shape your margin — see the Flat Quote field below.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-bold text-ink">Trip Fee ($, optional)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={tripFee}
              onChange={(e) => setTripFee(e.target.value)}
              onBlur={() => updateProposal({ trip_fee: tripFee.trim() ? Number(tripFee) : null })}
              disabled={isLocked}
              placeholder="Leave blank if none"
              className="field mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Assessment Fee ($, optional)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={assessmentFee}
              onChange={(e) => setAssessmentFee(e.target.value)}
              onBlur={() => updateProposal({ assessment_fee: assessmentFee.trim() ? Number(assessmentFee) : null })}
              disabled={isLocked}
              placeholder="Leave blank if none"
              className="field mt-1"
            />
          </div>
          <p className="sm:col-span-2 text-xs text-ink-faint">
            Enter these manually when you're charging a trip or assessment fee. The AI adds them to the proposal as their own line
            items, billed to the client at exactly what you enter here — no markup.
          </p>
        </div>

        <div>
          <label className="text-sm font-bold text-ink">Technician's Flat Quote ($, optional)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={flatQuote}
            onChange={(e) => setFlatQuote(e.target.value)}
            onBlur={() => updateProposal({ technician_flat_quote: flatQuote.trim() ? Number(flatQuote) : null })}
            disabled={isLocked}
            placeholder="e.g. 350 — only if the technician gave one all-in price instead of an hourly rate"
            className="field mt-1"
          />
          <p className="mt-1 text-xs text-ink-faint">
            Fill this in when the technician just asks for one flat price covering labor and parts together, instead of an hourly rate.
            This flat amount is what you actually pay him, no matter how many hours end up billed — your Technician/Helper rate per hour
            is still never adjusted. So the AI sizes a realistic, defensible breakdown of hours, helper time, and parts/materials (based
            on your Markup %, applied against this flat amount) to bill the client — since what you pay him doesn't change with the hours
            billed, a fuller breakdown is what earns your margin here. Leave it blank to have the AI work from the hourly rate alone and
            figure out hours, helper need, and parts itself (margin there comes only from parts).
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-bold text-ink">Photos</label>
            {!isLocked && (
              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:text-brand-800 cursor-pointer">
                <Upload size={13} /> {uploading ? 'Uploading...' : 'Add photo'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setUploading(true)
                    try {
                      await uploadPhoto(file)
                    } finally {
                      setUploading(false)
                      e.target.value = ''
                    }
                  }}
                />
              </label>
            )}
          </div>
          {photos.length === 0 && <p className="text-xs text-ink-faint">No photos yet.</p>}
          <div className="flex flex-wrap gap-3">
            {photos.map((p) => (
              <div key={p.id} className="relative group">
                {photoUrls[p.id] ? (
                  <img
                    src={photoUrls[p.id]}
                    alt={p.caption || ''}
                    className="w-24 h-24 object-cover rounded-lg border border-line"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-lg border border-line bg-canvas" />
                )}
                {!isLocked && (
                  <button
                    onClick={() => deletePhoto(p)}
                    className="absolute -top-1.5 -right-1.5 bg-white border border-line rounded-full p-1 text-ink-faint hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {!isLocked && (
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            onClick={handleGenerate}
            disabled={generating || !notes.trim() || (!technicianRate.trim() && !flatQuote.trim())}
            title={
              !technicianRate.trim() && !flatQuote.trim()
                ? 'Enter a technician rate (or a flat quote) first so the AI can price the labor'
                : ''
            }
          >
            {generating ? 'Generating...' : proposal.ai_generated_at ? 'Regenerate AI Draft' : 'Generate AI Draft'}
          </Button>
        )}
      </div>

      {proposal.ai_pricing_note && (
        <div className="panel p-4 border-l-4 border-l-amber-500 bg-amber-50 flex gap-3">
          <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-xs font-bold text-amber-800">Pricing note -- for you only, not shown to the client</p>
            <p className="text-xs text-amber-900">{proposal.ai_pricing_note}</p>
          </div>
        </div>
      )}

      {proposal.approval_likelihood_pct != null && (
        <ApprovalLikelihoodPanel
          pct={proposal.approval_likelihood_pct}
          basisN={proposal.approval_likelihood_basis_n}
          scope={proposal.approval_likelihood_scope}
        />
      )}

      <div className="panel p-5 space-y-4">
        <h3 className="text-sm font-bold text-ink">Client-Facing Narrative</h3>
        <NarrativeField
          label="Scope of Work"
          value={proposal.narrative_scope}
          disabled={isLocked}
          onSave={(v) => updateProposal({ narrative_scope: v })}
        />
        <NarrativeField
          label="Findings"
          value={proposal.narrative_findings}
          disabled={isLocked}
          onSave={(v) => updateProposal({ narrative_findings: v })}
        />
        <NarrativeField
          label="Recommendation"
          value={proposal.narrative_recommendation}
          disabled={isLocked}
          onSave={(v) => updateProposal({ narrative_recommendation: v })}
        />
        <NarrativeField
          label="Terms"
          value={proposal.terms}
          disabled={isLocked}
          rows={4}
          onSave={(v) => updateProposal({ terms: v })}
        />
      </div>

      <div className="panel p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-bold text-ink">Line Items</h3>
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-ink-soft">Markup %</label>
            <input
              type="number"
              value={markupPct}
              disabled={isLocked}
              onChange={(e) => setMarkupPct(e.target.value)}
              onBlur={() => updateProposal({ markup_pct: Number(markupPct) || 0 })}
              className="field w-20 py-1"
            />
          </div>
        </div>
        <p className="text-xs text-ink-faint -mt-2">
          Applies to parts/materials (and any "Other" cost) — Technician/Helper labor always bills at the rate you entered, never marked
          up. On a flat-quote job, this % also sets the AI's target for the whole proposal, since what you pay him is fixed regardless of
          the hours billed.
        </p>

        {needsManual && (
          <p className="text-xs text-warn bg-warn-tint border border-warn/20 rounded-lg px-3 py-2">
            Some line items didn't match a known labor role or part — set their cost manually below.
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="table-head-row">
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Unit Price</th>
                <th className="px-3 py-2 text-right">Total</th>
                {!isLocked && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li) => (
                <LineItemRow
                  key={li.id}
                  item={li}
                  disabled={isLocked}
                  onChange={(patch) => updateLineItem(li.id, patch)}
                  onDelete={() => deleteLineItem(li.id)}
                />
              ))}
              {!lineItems.length && (
                <tr>
                  <td colSpan={6} className="text-center text-ink-faint py-6">
                    No line items yet. Generate an AI draft or add one manually.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {!isLocked && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => handleAddLineItem('labor')}>
              Labor
            </Button>
            <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => handleAddLineItem('part')}>
              Part
            </Button>
            <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => handleAddLineItem('other')}>
              Other
            </Button>
          </div>
        )}

        <div className="flex justify-end">
          <div className="text-right space-y-1">
            <p className="text-xs text-ink-faint">
              Price Subtotal: <span className="font-semibold text-ink-soft">${subtotalPrice.toFixed(2)}</span>
            </p>
            {isFlatQuoteMode ? (
              <p className="text-xs text-ink-faint" title="What the technician is actually paid, flat -- doesn't change based on the hours/parts billed below.">
                Technician's Flat Cost: ${flatCostDisplay.toFixed(2)}
              </p>
            ) : (
              <>
                <p className="text-xs text-ink-faint">Technician Cost: ${technicianCost.toFixed(2)}</p>
                <p className="text-xs text-ink-faint">Parts Cost: ${partsCost.toFixed(2)}</p>
              </>
            )}
            {otherCost > 0 && <p className="text-xs text-ink-faint">Other Cost (fees, etc): ${otherCost.toFixed(2)}</p>}
            <p className={`text-xs font-semibold ${belowFloor ? 'text-danger' : 'text-ink-soft'}`}>
              Margin: {marginPct.toFixed(1)}% {belowFloor && `— below ${MARGIN_FLOOR_PCT}% floor`}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" icon={<Download size={14} />} onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting...' : 'Export .docx'}
        </Button>
        {proposal.status !== 'approved' && proposal.status !== 'sent' && (
          <Button
            variant="primary"
            icon={<CheckCircle2 size={14} />}
            onClick={() => updateProposal({ status: 'approved', approved_at: new Date().toISOString() })}
            disabled={belowFloor}
            title={belowFloor ? `Margin is below the ${MARGIN_FLOOR_PCT}% floor` : ''}
            className="!bg-good hover:!bg-good/90"
          >
            Approve
          </Button>
        )}
        {proposal.status === 'approved' && (
          <Button
            variant="primary"
            icon={<Send size={14} />}
            onClick={() => updateProposal({ status: 'sent', sent_at: new Date().toISOString() })}
          >
            Mark Sent
          </Button>
        )}
      </div>

      {(proposal.status === 'approved' || proposal.status === 'sent') && (
        <ClientOutcomePanel
          existing={outcomes.find((o) => o.proposal_id === proposal.id) ?? null}
          onSave={(outcome, feedback) =>
            recordProposalOutcome(proposal.id, {
              dispatcher_name: proposal.dispatcher_name,
              client: proposal.client_name ?? workOrder?.client ?? null,
              store: null,
              trade: workOrder?.trade ?? null,
              subtrade: workOrder?.subtrade ?? null,
              job_description: workOrder?.description ?? null,
              total_price: subtotalPrice,
              total_cost: subtotalCost,
              markup_pct: Number(proposal.markup_pct) || null,
              outcome,
              client_feedback: feedback || null,
            })
          }
        />
      )}
    </div>
  )
}

function ClientOutcomePanel({
  existing,
  onSave,
}: {
  existing: { outcome: QuoteOutcomeResult; client_feedback: string | null } | null
  onSave: (outcome: QuoteOutcomeResult, feedback: string) => Promise<void>
}) {
  const [outcome, setOutcome] = useState<QuoteOutcomeResult>(existing?.outcome ?? 'approved')
  const [feedback, setFeedback] = useState(existing?.client_feedback ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setOutcome(existing?.outcome ?? 'approved')
    setFeedback(existing?.client_feedback ?? '')
  }, [existing?.outcome, existing?.client_feedback])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await onSave(outcome, feedback)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel p-4 space-y-2">
      <h3 className="text-sm font-bold text-ink">What did the client do with this quote?</h3>
      <p className="text-xs text-ink-faint">
        This feeds the AI Learning tab -- labeling real outcomes helps future proposals price closer to what actually gets approved.
      </p>
      <div className="flex flex-wrap items-end gap-2 pt-1">
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as QuoteOutcomeResult)} className="field w-56">
          {Object.entries(QUOTE_OUTCOME_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <input
          placeholder="What did the client say? (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          className="field flex-1 min-w-[220px]"
        />
        <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : existing ? 'Update' : 'Save'}
        </Button>
        {saved && <span className="text-xs text-good">Saved</span>}
      </div>
    </div>
  )
}

function NarrativeField({
  label,
  value,
  disabled,
  rows = 3,
  onSave,
}: {
  label: string
  value: string | null
  disabled: boolean
  rows?: number
  onSave: (v: string) => void
}) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => setV(value ?? ''), [value])
  return (
    <div>
      <label className="field-label">{label}</label>
      <textarea
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onSave(v)}
        rows={rows}
        className="field"
      />
    </div>
  )
}

function LineItemRow({
  item,
  disabled,
  onChange,
  onDelete,
}: {
  item: ProposalLineItem
  disabled: boolean
  onChange: (patch: Partial<ProposalLineItem>) => void
  onDelete: () => void
}) {
  const [desc, setDesc] = useState(item.description)
  const [qty, setQty] = useState(String(item.quantity))
  const [price, setPrice] = useState(String(item.unit_price))

  useEffect(() => {
    setDesc(item.description)
    setQty(String(item.quantity))
    setPrice(String(item.unit_price))
  }, [item.id, item.description, item.quantity, item.unit_price])

  const total = (Number(qty) || 0) * (Number(price) || 0)

  return (
    <tr className="border-b border-line">
      <td className="px-3 py-2 text-ink-faint capitalize">
        {item.kind}
        {item.needs_manual_pricing && (
          <span className="ml-1 text-warn" title="Needs manual pricing">
            ●
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <input
          value={desc}
          disabled={disabled}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => onChange({ description: desc })}
          className="field-inline w-full min-w-[12rem]"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          value={qty}
          disabled={disabled}
          onChange={(e) => setQty(e.target.value)}
          onBlur={() => onChange({ quantity: Number(qty) || 0 })}
          className="field-inline w-16"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          value={price}
          disabled={disabled}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={() => onChange({ unit_price: Number(price) || 0 })}
          className="field-inline w-20"
        />
      </td>
      <td className="px-3 py-2 text-right text-ink-soft">${total.toFixed(2)}</td>
      {!disabled && (
        <td className="px-3 py-2 text-right">
          <button onClick={onDelete} className="text-ink-faint hover:text-danger transition-colors">
            <Trash2 size={14} />
          </button>
        </td>
      )}
    </tr>
  )
}

// Visual read on how this proposal's price has landed historically -- NOT an
// AI-stated confidence score (language models are poorly calibrated at that).
// Instead it's the % of the N real, logged AI-Learning outcomes closest in
// price to this proposal's total that actually got approved -- a plain,
// explainable stat from the dispatcher's own history, shown as a two-segment
// split bar so it reads at a glance alongside the price-approval reasoning
// above it.
function ApprovalLikelihoodPanel({ pct, basisN, scope }: { pct: number; basisN: number | null; scope: string | null }) {
  const rejectedPct = 100 - pct
  return (
    <div className="panel p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink flex items-center gap-2">
          <Gauge size={16} className="text-ink-faint" />
          Approval Likelihood
        </h3>
        {basisN != null && (
          <span className="text-xs text-ink-faint">
            Based on the {basisN} closest-priced past job{basisN === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="flex h-3 rounded-full overflow-hidden bg-canvas">
        {pct > 0 && <div className="bg-good" style={{ width: `${pct}%` }} />}
        {rejectedPct > 0 && <div className="bg-danger" style={{ width: `${rejectedPct}%` }} />}
      </div>

      <div className="flex items-center justify-between text-xs font-bold">
        <span className="text-good">{pct}% likely approved</span>
        <span className="text-danger">{rejectedPct}% likely rejected or revised</span>
      </div>

      <p className="text-xs text-ink-soft">
        Of the past jobs {scope ?? 'in your AI Learning history'} priced closest to this proposal's total, {pct}% were approved as-is.
        It's a pattern match against real outcomes, not a guarantee -- use it as one more data point alongside your own judgment.
      </p>
    </div>
  )
}
