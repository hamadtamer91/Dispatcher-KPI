import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useProposals } from '../hooks/useProposals'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { PROPOSAL_STATUS_LABELS } from '../lib/types'
import type { ProposalStatus, Role } from '../lib/types'
import { Badge, Button, PageHeader } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

const STATUS_VARIANT: Record<ProposalStatus, BadgeVariant> = {
  draft: 'neutral',
  ai_generated: 'brand',
  in_review: 'warn',
  approved: 'good',
  sent: 'good',
}

export function ProposalsPage({ role, dispatcherName }: { role: Role; dispatcherName: string | null }) {
  const { proposals, loading, error, createProposal } = useProposals()
  const { wos } = useWorkOrders()
  const navigate = useNavigate()
  const [newWo, setNewWo] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')

  const handleCreate = async () => {
    const wo = newWo.trim()
    if (!wo) return
    setCreating(true)
    setCreateErr('')
    try {
      const matchedWo = wos.find((w) => w.wo === wo)
      const dispatcherForProposal = role === 'dispatcher' ? dispatcherName : (matchedWo?.dispatcher ?? null)
      const proposal = await createProposal(wo, dispatcherForProposal)
      navigate(`/proposals/${proposal.id}`)
    } catch (e) {
      setCreateErr((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proposals"
        actions={
          <>
            <input
              value={newWo}
              onChange={(e) => setNewWo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="Work order #"
              className="field w-40"
            />
            <Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={creating || !newWo.trim()} onClick={handleCreate}>
              New Proposal
            </Button>
          </>
        }
      />
      {createErr && <p className="text-sm text-danger">{createErr}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="panel overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              <th className="px-4 py-3">WO</th>
              <th className="px-4 py-3">Store</th>
              <th className="px-4 py-3">Dispatcher</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Version</th>
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
              proposals.map((p) => {
                const wo = wos.find((w) => w.wo === p.wo)
                return (
                  <tr
                    key={p.id}
                    className="table-row cursor-pointer"
                    onClick={() => navigate(`/proposals/${p.id}`)}
                  >
                    <td className="px-4 py-2.5 font-semibold text-ink">{p.wo}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{wo?.client || '—'}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{p.dispatcher_name || '—'}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={STATUS_VARIANT[p.status]}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-ink-faint">v{p.version}</td>
                    <td className="px-4 py-2.5 text-right text-ink tabular-nums">${p.subtotal_price.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-ink-faint whitespace-nowrap">
                      {new Date(p.updated_at).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            {!loading && !proposals.length && (
              <tr>
                <td colSpan={7} className="text-center text-ink-faint py-8">No proposals yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
