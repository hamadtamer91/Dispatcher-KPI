import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { useQuoteOutcomes } from '../hooks/useQuoteOutcomes'
import { QUOTE_OUTCOME_LABELS } from '../lib/types'
import type { QuoteOutcomeResult } from '../lib/types'
import { Badge, Button, PageHeader } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const OUTCOME_VARIANT: Record<QuoteOutcomeResult, BadgeVariant> = {
  approved: 'good',
  rejected: 'danger',
  revision_requested: 'warn',
}

const emptyForm = {
  client: '',
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
  const { outcomes, loading, error, addOutcome, deleteOutcome } = useQuoteOutcomes()
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')

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

  const handleAdd = async () => {
    if (!form.job_description.trim() && !form.trade.trim()) {
      setSaveErr('Add at least a trade or a short description of the job.')
      return
    }
    setSaving(true)
    setSaveErr('')
    try {
      await addOutcome({
        proposal_id: null,
        dispatcher_name: null,
        client: form.client.trim() || null,
        trade: form.trade.trim() || null,
        subtrade: form.subtrade.trim() || null,
        job_description: form.job_description.trim() || null,
        total_price: form.total_price.trim() ? Number(form.total_price) : null,
        total_cost: form.total_cost.trim() ? Number(form.total_cost) : null,
        markup_pct: form.markup_pct.trim() ? Number(form.markup_pct) : null,
        outcome: form.outcome,
        client_feedback: form.client_feedback.trim() || null,
      })
      setForm(emptyForm)
    } catch (e) {
      setSaveErr((e as Error).message)
    } finally {
      setSaving(false)
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

      <div className="panel p-5 space-y-3">
        <h3 className="text-sm font-bold text-ink">Add a past quote</h3>
        {saveErr && <p className="text-sm text-danger">{saveErr}</p>}
        <div className="grid sm:grid-cols-3 gap-2">
          <input placeholder="Client / store (optional)" value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} className="field" />
          <input placeholder="Trade (e.g. Plumbing)" value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value })} className="field" />
          <input placeholder="Subtrade (optional)" value={form.subtrade} onChange={(e) => setForm({ ...form, subtrade: e.target.value })} className="field" />
        </div>
        <textarea
          placeholder="What was the job? (short description of scope/work done)"
          value={form.job_description}
          onChange={(e) => setForm({ ...form, job_description: e.target.value })}
          className="field w-full min-h-[70px]"
        />
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
        <div className="flex justify-end">
          <Button variant="primary" icon={<Plus size={14} />} onClick={handleAdd} disabled={saving}>
            {saving ? 'Saving...' : 'Add to AI Learning'}
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
              <tr><td colSpan={9} className="text-center text-ink-faint py-6">Loading...</td></tr>
            )}
            {!loading && !outcomes.length && (
              <tr><td colSpan={9} className="text-center text-ink-faint py-6">Nothing labeled yet -- add a past quote above, or label a sent proposal from its own page.</td></tr>
            )}
            {outcomes.map((o) => (
              <tr key={o.id} className="table-row">
                <td className="px-4 py-3 text-xs text-ink-faint whitespace-nowrap">
                  {o.proposal_id ? (
                    <Link to={`/proposals/${o.proposal_id}`} className="text-brand-600 hover:underline">
                      In-app
                    </Link>
                  ) : (
                    'Manual'
                  )}
                </td>
                <td className="px-4 py-3">{o.client ?? '—'}</td>
                <td className="px-4 py-3">{[o.trade, o.subtrade].filter(Boolean).join(' / ') || '—'}</td>
                <td className="px-4 py-3 max-w-[220px] truncate" title={o.job_description ?? ''}>{o.job_description ?? '—'}</td>
                <td className="px-4 py-3 text-right">{o.total_price != null ? `$${Number(o.total_price).toFixed(2)}` : '—'}</td>
                <td className="px-4 py-3 text-right">{o.markup_pct != null ? `${o.markup_pct}%` : '—'}</td>
                <td className="px-4 py-3"><Badge variant={OUTCOME_VARIANT[o.outcome]}>{QUOTE_OUTCOME_LABELS[o.outcome]}</Badge></td>
                <td className="px-4 py-3 max-w-[220px] truncate" title={o.client_feedback ?? ''}>{o.client_feedback ?? '—'}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => deleteOutcome(o.id)} className="btn-icon hover:text-danger">
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
