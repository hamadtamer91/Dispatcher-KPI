import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useProposals } from '../hooks/useProposals'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { PROPOSAL_STATUS_LABELS } from '../lib/types'
import type { ProposalStatus } from '../lib/types'
import { Badge, Button, EmptyState, PageHeader } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const STATUS_VARIANT: Record<ProposalStatus, BadgeVariant> = {
  draft: 'neutral',
  ai_generated: 'brand',
  in_review: 'warn',
  approved: 'good',
  sent: 'good',
}

// Double-checks a proposal that already has a narrative written -- catches
// things like a narrative that says "repaired the door" while a line item
// bills a brand-new door, plus sales-tax/EMG-rate mistakes for Global
// Maintenance Network. Report-only: nothing here edits the proposal itself,
// the dispatcher fixes anything flagged back in the proposal editor.
export function BreakdownPage() {
  const { proposals, loading, error } = useProposals()
  const { wos } = useWorkOrders()
  const navigate = useNavigate()

  const narrated = proposals.filter((p) => !!p.narrative_scope?.trim())

  return (
    <div className="space-y-4">
      <PageHeader
        title="Breakdown"
        description="Pick a proposal that already has a narrative to double-check its pricing, tax, and whether the parts/labor actually match what the narrative describes."
        actions={
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => navigate('/breakdown/paste')}>
            Paste a Proposal
          </Button>
        }
      />
      {error && <p className="text-sm text-danger">{error}</p>}

      {!loading && !narrated.length ? (
        <EmptyState>No proposals with a narrative yet. Write or generate a narrative on a proposal first, then it'll show up here to check.</EmptyState>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="table-head-row">
                <th className="px-4 py-3">WO</th>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">City / State</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="text-center text-ink-faint py-8">Loading...</td>
                </tr>
              )}
              {!loading &&
                narrated.map((p) => {
                  const wo = wos.find((w) => w.wo === p.wo)
                  const city = p.city || wo?.city
                  const state = p.state || wo?.state
                  return (
                    <tr
                      key={p.id}
                      className="table-row cursor-pointer"
                      onClick={() => navigate(`/breakdown/${p.id}`)}
                    >
                      <td className="px-4 py-2.5 font-semibold text-ink">{p.wo}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{p.client_name || wo?.client || '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{[city, state].filter(Boolean).join(', ') || '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{p.priority || '—'}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={STATUS_VARIANT[p.status]}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink tabular-nums">${p.subtotal_price.toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-ink-faint whitespace-nowrap">
                        {new Date(p.updated_at).toLocaleDateString()}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
