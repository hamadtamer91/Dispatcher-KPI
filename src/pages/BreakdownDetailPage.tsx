import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ClipboardCheck, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useProposalDetail } from '../hooks/useProposalDetail'
import type { BreakdownResult, BreakdownSeverity } from '../hooks/useProposalDetail'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { PROPOSAL_STATUS_LABELS } from '../lib/types'
import type { ProposalStatus } from '../lib/types'
import { Badge, Button, PageHeader, Panel } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const STATUS_VARIANT: Record<ProposalStatus, BadgeVariant> = {
  draft: 'neutral',
  ai_generated: 'brand',
  in_review: 'warn',
  approved: 'good',
  sent: 'good',
}

const SEVERITY_VARIANT: Record<BreakdownSeverity, BadgeVariant> = {
  high: 'danger',
  medium: 'warn',
  low: 'neutral',
}

const CATEGORY_LABELS: Record<string, string> = {
  totals: 'Totals',
  tax: 'Sales Tax',
  rate_sheet: 'Rate Sheet',
  equal_hours: 'Equal Hours',
  scope_mismatch: 'Scope vs. Line Items',
  other: 'Other',
}

/** Read-only AI double-check for a proposal that already has a narrative --
 *  reused across the pricing breakdown, GMN sales-tax/EMG/rate-sheet rules,
 *  and whether the parts/labor actually match the narrative's scope (e.g.
 *  narrative says "repaired the door" but a line item bills a new one).
 *  Never writes to the proposal -- fixes happen by hand in the editor. */
export function BreakdownDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { proposal, lineItems, loading, error, checkingBreakdown, runBreakdownCheck } = useProposalDetail(id)
  const { wos } = useWorkOrders()
  const [result, setResult] = useState<BreakdownResult | null>(null)
  const [checkError, setCheckError] = useState('')

  const wo = wos.find((w) => w.wo === proposal?.wo)
  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0)

  const handleRunCheck = async () => {
    setCheckError('')
    setResult(null)
    try {
      const r = await runBreakdownCheck()
      setResult(r)
    } catch (e) {
      setCheckError((e as Error).message)
    }
  }

  if (loading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading...</p>
  }
  if (!proposal) {
    return <p className="text-sm text-danger py-8 text-center">{error || 'Proposal not found.'}</p>
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Breakdown: WO ${proposal.wo}`}
        description="Double-checks this proposal's pricing, tax, and whether the parts/labor match the narrative. Nothing here is applied automatically."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate('/breakdown')}>
              Back
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate(`/proposals/${proposal.id}`)}>
              Open in Proposal Editor
            </Button>
          </>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      {/* The fields the check itself relies on -- called out up front so
          it's obvious when one is missing before relying on the result. */}
      <Panel className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <Field label="Work Order #" value={proposal.wo} />
          <Field label="Client" value={proposal.client_name || wo?.client || '—'} />
          <Field label="City" value={proposal.city || wo?.city || '—'} />
          <Field label="State" value={proposal.state || wo?.state || '—'} />
          <Field label="Priority" value={proposal.priority || '(none set)'} />
          <Field label="Trade" value={proposal.trade_name || wo?.trade || '—'} />
          <Field
            label="Status"
            value={<Badge variant={STATUS_VARIANT[proposal.status]}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Badge>}
          />
          <Field label="Current Total" value={`$${subtotal.toFixed(2)}`} />
        </div>
      </Panel>

      <Panel className="p-4 space-y-3">
        <p className="text-sm font-bold text-ink">Narrative</p>
        <NarrativeBlock label="Scope of work" text={proposal.narrative_scope} />
        <NarrativeBlock label="Findings" text={proposal.narrative_findings} />
        <NarrativeBlock label="Recommendation" text={proposal.narrative_recommendation} />
      </Panel>

      <Panel className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Unit Price</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((li) => (
              <tr key={li.id} className="table-row">
                <td className="px-4 py-2.5 text-ink-faint capitalize">{li.kind}</td>
                <td className="px-4 py-2.5 text-ink">{li.description || '—'}</td>
                <td className="px-4 py-2.5 text-right text-ink-soft tabular-nums">{li.quantity}</td>
                <td className="px-4 py-2.5 text-right text-ink-soft tabular-nums">${li.unit_price.toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-ink tabular-nums">${(li.quantity * li.unit_price).toFixed(2)}</td>
              </tr>
            ))}
            {!lineItems.length && (
              <tr>
                <td colSpan={5} className="text-center text-ink-faint py-8">No line items yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-ink">AI Breakdown Check</p>
          <Button
            variant="primary"
            size="sm"
            icon={checkingBreakdown ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
            disabled={checkingBreakdown}
            onClick={handleRunCheck}
          >
            {checkingBreakdown ? 'Checking...' : 'Run Breakdown Check'}
          </Button>
        </div>

        {checkError && <p className="text-sm text-danger">{checkError}</p>}

        {result && (
          <div className="space-y-3">
            {result.overall_assessment && <p className="text-sm text-ink-soft italic">{result.overall_assessment}</p>}
            {result.findings.length === 0 ? (
              <p className="text-sm text-good flex items-center gap-1.5">
                <CheckCircle2 size={16} /> No issues found -- pricing, tax, and scope all look consistent.
              </p>
            ) : (
              <ul className="space-y-2">
                {result.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 rounded-lg border border-line bg-canvas p-3">
                    <AlertTriangle size={16} className="shrink-0 mt-0.5 text-warn" />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity.toUpperCase()}</Badge>
                        <span className="text-xs font-semibold text-ink-faint">{CATEGORY_LABELS[f.category] ?? f.category}</span>
                      </div>
                      <p className="text-sm text-ink">{f.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-ink-faint">
              Checked {new Date(result.checked_at).toLocaleString()}. Fix anything flagged in the Proposal Editor, then run the check again.
            </p>
          </div>
        )}
      </Panel>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold text-ink-faint uppercase tracking-wide mb-0.5">{label}</p>
      <div className="text-sm font-semibold text-ink">{value}</div>
    </div>
  )
}

function NarrativeBlock({ label, text }: { label: string; text: string | null }) {
  if (!text?.trim()) return null
  return (
    <div>
      <p className="text-[11px] font-bold text-ink-faint uppercase tracking-wide mb-1">{label}</p>
      <p className="text-sm text-ink-soft whitespace-pre-wrap">{text}</p>
    </div>
  )
}
