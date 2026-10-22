import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, Sparkles, Pencil, X } from 'lucide-react'
import { useQuoteOutcomes } from '../hooks/useQuoteOutcomes'
import { QUOTE_OUTCOME_LABELS } from '../lib/types'
import type { QuoteOutcome, QuoteOutcomeResult } from '../lib/types'
import { Badge, Button, PageHeader } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const OUTCOME_VARIANT: Record<QuoteOutcomeResult, BadgeVariant> = {
  approved: 'good',
  rejected: 'danger',
  revision_requested: 'warn',
}

const emptyForm = {
  client: '',
  store: '',
  trade: '',
  subtrade: '',
  job_description: '',
  total_price: '',
  total_cost: '',
  markup_pct: '',
  outcome: 'approved' as QuoteOutcomeResult,
  client_feedback: '',
}

export function AiLearningPage() {
  const { outcomes, loading, error, addOutcome, updateOutcome, deleteOutcome, parseQuoteText } = useQuoteOutcomes()
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseErr, setParseErr] = useState('')
  const [parsedNote, setParsedNote] = useState('')
  const formRef = useRef<HTMLDivElement>(null)

  const stats = useMemo(() => {
    const total = outcomes.length
    const count = (r: QuoteOutcomeResult) => outcomes.filter((o) => o.outcome === r).length
    return {
      total,
      approved: count('approved'),
      rejected: count('rejected'),
      revision_requested: count('revision_requested'),
    }
  }, [outcomes])

  const handleSave = async () => {
    if (!form.job_description.trim() && !form.trade.trim()) {
      setSaveErr('Add at least a trade or a short description of the job.')
      return
    }
    setSaving(true)
    setSaveErr('')
    const patch = {
      client: form.client.trim() || null,
      store: form.store.trim() || null,
      trade: form.trade.trim() || null,
      subtrade: form.subtrade.trim() || null,
      job_description: form.job_description.trim() || null,
      total_price: form.total_price.trim() ? Number(form.total_price) : null,
      total_cost: form.total_cost.trim() ? Number(form.total_cost) : null,
      markup_pct: form.markup_pct.trim() ? Number(form.markup_pct) : null,
      outcome: form.outcome,
      client_feedback: form.client_feedback.trim() || null,
    }
    try {
      if (editingId) {
        await updateOutcome(editingId, patch)
      } else {
        await addOutcome({ proposal_id: null, dispatcher_name: null, ...patch })
      }
      setForm(emptyForm)
      setEditingId(null)
    } catch (e) {
      setSaveErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (o: QuoteOutcome) => {
    setSaveErr('')
    setParseErr('')
    setParsedNote('')
    setEditingId(o.id)
    setForm({
      client: o.client ?? '',
      store: o.store ?? '',
      trade: o.trade ?? '',
      subtrade: o.subtrade ?? '',
      job_description: o.job_description ?? '',
      total_price: o.total_price != null ? String(o.total_price) : '',
      total_cost: o.total_cost != null ? String(o.total_cost) : '',
      markup_pct: o.markup_pct != null ? String(o.markup_pct) : '',
      outcome: o.outcome,
      client_feedback: o.client_feedback ?? '',
    })
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleCancelEdit = () => {
    setForm(emptyForm)
    setEditingId(null)
    setSaveErr('')
  }

  const handleParse = async () => {
    if (!form.job_description.trim()) {
      setParseErr('Paste the quote text into the job box above first.')
      return
    }
    setParsing(true)
    setParseErr('')
    setParsedNote('')
    try {
      const parsed = await parseQuoteText(form.job_description)
      if (parsed.total_price == null) {
        setParseErr("Couldn't find a total in that text -- enter the price manually.")
        return
      }
      setForm((f) => ({
        ...f,
        total_price: String(parsed.total_price),
        total_cost: parsed.total_cost != null ? String(parsed.total_cost) : f.total_cost,
        markup_pct: parsed.markup_pct != null ? String(parsed.markup_pct) : f.markup_pct,
        trade: f.trade.trim() ? f.trade : parsed.trade ?? f.trade,
      }))
      setParsedNote(`Found total: $${Number(parsed.total_price).toFixed(2)} -- review below before saving.`)
    } catch (e) {
      setParseErr((e as Error).message)
    } finally {
      setParsing(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Learning"
        description="Feed the AI real outcomes -- old quotes and sent proposals, labeled with what the client actually did -- so new proposals price closer to what tends to get approved. Proposals sent from this app can be labeled directly on their own page; use the form below for quotes from before this system, or ones done outside it."
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total labeled" value={stats.total} />
        <StatCard label="Approved" value={stats.approved} variant="good" />
        <StatCard label="Rejected" value={stats.rejected} variant="danger" />
        <StatCard label="Asked to revise" value={stats.revision_requested} variant="warn" />
      </div>

      <div ref={formRef} className="panel p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-ink">{editingId ? 'Edit quote' : 'Add a past quote'}</h3>
          {editingId && (
            <button onClick={handleCancelEdit} className="btn-icon text-ink-faint hover:text-ink flex items-center gap-1 text-xs">
              <X size={14} /> Cancel
            </button>
          )}
        </div>
        {saveErr && <p className="text-sm text-danger">{saveErr}</p>}
        <div className="grid sm:grid-cols-4 gap-2">
          <input placeholder="Client (e.g. CBRE)" value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} className="field" />
          <input placeholder="Store (optional, e.g. Store #1234)" value={form.store} onChange={(e) => setForm({ ...form, store: e.target.value })} className="field" />
          <input placeholder="Trade (e.g. Plumbing)" value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value })} className="field" />
          <input placeholder="Subtrade (optional)" value={form.subtrade} onChange={(e) => setForm({ ...form, subtrade: e.target.value })} className="field" />
        </div>
        <textarea
          placeholder="What was the job? Paste the full quote/breakdown text here if you have it (trip fee, labor, parts, grand total, etc) -- or just a short description."
          value={form.job_description}
          onChange={(e) => setForm({ ...form, job_description: e.target.value })}
          className="field w-full min-h-[110px]"
        />
        <div className="flex items-center gap-3">
          <Button variant="secondary" icon={<Sparkles size={14} />} onClick={handleParse} disabled={parsing}>
            {parsing ? 'Reading...' : 'Pull total from pasted text'}
          </Button>
          {parseErr && <p className="text-sm text-danger">{parseErr}</p>}
          {!parseErr && parsedNote && <p className="text-sm text-good">{parsedNote}</p>}
        </div>
        <div className="grid sm:grid-cols-4 gap-2">
          <input placeholder="Total price quoted $" type="number" value={form.total_price} onChange={(e) => setForm({ ...form, total_price: e.target.value })} className="field" />
          <input placeholder="Cost (optional) $" type="number" value={form.total_cost} onChange={(e) => setForm({ ...form, total_cost: e.target.value })} className="field" />
          <input placeholder="Markup % (optional)" type="number" value={form.markup_pct} onChange={(e) => setForm({ ...form, markup_pct: e.target.value })} className="field" />
          <select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value as QuoteOutcomeResult })} className="field">
            {Object.entries(QUOTE_OUTCOME_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </div>
        <textarea
          placeholder="What did the client say? (e.g. 'too expensive', 'wanted the part swapped for a cheaper one') -- this is what helps the AI most"
          value={form.client_feedback}
          onChange={(e) => setForm({ ...form, client_feedback: e.target.value })}
          className="field w-full min-h-[60px]"
        />
        <div className="flex justify-end gap-2">
          {editingId && (
            <Button variant="secondary" onClick={handleCancelEdit} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button variant="primary" icon={<Plus size={14} />} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add to AI Learning'}
          </Button>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        {error && <p className="text-sm text-danger p-4">{error}</p>}
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Store</th>
              <th className="px-4 py-3">Trade</th>
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3 text-right">Markup</th>
              <th className="px-4 py-3">Outcome</th>
              <th className="px-4 py-3">Client feedback</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={10} className="text-center text-ink-faint py-6">Loading...</td></tr>
            )}
            {!loading && !outcomes.length && (
              <tr><td colSpan={10} className="text-center text-ink-faint py-6">Nothing labeled yet -- add a past quote above, or label a sent proposal from its own page.</td></tr>
            )}
            {outcomes.map((o) => (
              <tr
                key={o.id}
                className={`table-row cursor-pointer ${editingId === o.id ? 'bg-brand-50' : ''}`}
                onClick={() => handleEdit(o)}
              >
                <td className="px-4 py-3 text-xs text-ink-faint whitespace-nowrap">
                  {o.proposal_id ? (
                    <Link
                      to={`/proposals/${o.proposal_id}`}
                      className="text-brand-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      In-app
                    </Link>
                  ) : (
                    'Manual'
                  )}
                </td>
                <td className="px-4 py-3">{o.client ?? '—'}</td>
                <td className="px-4 py-3">{o.store ?? '—'}</td>
                <td className="px-4 py-3">{[o.trade, o.subtrade].filter(Boolean).join(' / ') || '—'}</td>
                <td className="px-4 py-3 max-w-[220px] truncate" title={o.job_description ?? ''}>{o.job_description ?? '—'}</td>
                <td className="px-4 py-3 text-right">{o.total_price != null ? `$${Number(o.total_price).toFixed(2)}` : '—'}</td>
                <td className="px-4 py-3 text-right">{o.markup_pct != null ? `${o.markup_pct}%` : '—'}</td>
                <td className="px-4 py-3"><Badge variant={OUTCOME_VARIANT[o.outcome]}>{QUOTE_OUTCOME_LABELS[o.outcome]}</Badge></td>
                <td className="px-4 py-3 max-w-[220px] truncate" title={o.client_feedback ?? ''}>{o.client_feedback ?? '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={(e) => { e.stopPropagation(); handleEdit(o) }} className="btn-icon hover:text-brand-600">
                    <Pencil size={14} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); deleteOutcome(o.id) }} className="btn-icon hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatCard({ label, value, variant }: { label: string; value: number; variant?: BadgeVariant }) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${variant === 'good' ? 'text-good' : variant === 'danger' ? 'text-danger' : variant === 'warn' ? 'text-warn' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  )
}
