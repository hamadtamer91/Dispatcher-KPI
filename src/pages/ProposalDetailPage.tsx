import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Download, Plus, Send, Sparkles, Trash2, Upload } from 'lucide-react'
import { useProposalDetail } from '../hooks/useProposalDetail'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { exportProposalDocx } from '../lib/exportProposalDocx'
import { PROPOSAL_STATUS_LABELS } from '../lib/types'
import type { LineItemKind, ProposalLineItem, ProposalStatus } from '../lib/types'
import { Badge, Button } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const STATUS_VARIANT: Record<ProposalStatus, BadgeVariant> = {
  draft: 'neutral',
  ai_generated: 'brand',
  in_review: 'warn',
  approved: 'good',
  sent: 'good',
}

const MARGIN_FLOOR_PCT = 50

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

  const [notes, setNotes] = useState('')
  const [technicianRate, setTechnicianRate] = useState('')
  const [helperRate, setHelperRate] = useState('')
  const [flatQuote, setFlatQuote] = useState('')
  const [markupPct, setMarkupPct] = useState('75')
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [genError, setGenError] = useState('')

  useEffect(() => {
    if (proposal) {
      setNotes(proposal.technician_notes ?? '')
      setTechnicianRate(proposal.technician_rate != null ? String(proposal.technician_rate) : '')
      setHelperRate(proposal.helper_rate != null ? String(proposal.helper_rate) : '')
      setFlatQuote(proposal.technician_flat_quote != null ? String(proposal.technician_flat_quote) : '')
      setMarkupPct(String(proposal.markup_pct))
    }
  }, [
    proposal?.id,
    proposal?.technician_notes,
    proposal?.technician_rate,
    proposal?.helper_rate,
    proposal?.technician_flat_quote,
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

  const subtotalPrice = lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0)
  const technicianCost = lineItems.filter((li) => li.kind === 'labor').reduce((s, li) => s + li.quantity * li.unit_cost, 0)
  const partsCost = lineItems.filter((li) => li.kind === 'part').reduce((s, li) => s + li.quantity * li.unit_cost, 0)
  const otherCost = lineItems.filter((li) => li.kind === 'other').reduce((s, li) => s + li.quantity * li.unit_cost, 0)
  const subtotalCost = technicianCost + partsCost + otherCost
  const marginPct = subtotalPrice > 0 ? ((subtotalPrice - subtotalCost) / subtotalPrice) * 100 : 0
  const belowFloor = subtotalPrice > 0 && marginPct < MARGIN_FLOOR_PCT
  const needsManual = lineItems.some((li) => li.needs_manual_pricing)

  if (loading) return <p className="text-sm text-ink-faint py-8 text-center">Loading proposal...</p>
  if (!proposal) return <p className="text-sm text-danger">{error || 'Proposal not found.'}</p>

  const handleGenerate = async () => {
    setGenError('')
    try {
      await updateProposal({
        technician_notes: notes,
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
            {workOrder?.client || 'Unassigned store'} · {workOrder?.trade || 'n/a'} · v{proposal.version}
          </p>
        </div>
        <Badge variant={STATUS_VARIANT[proposal.status]}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Badge>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {genError && <p className="text-sm text-danger bg-danger-tint border border-danger/20 rounded-lg p-3">{genError}</p>}

      <div className="panel p-5 space-y-4">
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
            The AI decides the hours needed and whether a helper is required from the notes and photos — these rates are just what it
            multiplies those hours by. It'll fill in the breakdown as labor/part rows in the Line Items table below.
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
            When set, this whole amount becomes the single Technician cost line below (no hours math, no separate parts) and the hourly
            rate above is ignored. Leave it blank to have the AI work from the hourly rate and figure out hours, helper need, and parts
            itself.
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
            <p className="text-xs text-ink-faint">Technician Cost: ${technicianCost.toFixed(2)}</p>
            <p className="text-xs text-ink-faint">Parts Cost: ${partsCost.toFixed(2)}</p>
            {otherCost > 0 && <p className="text-xs text-ink-faint">Other Cost: ${otherCost.toFixed(2)}</p>}
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
