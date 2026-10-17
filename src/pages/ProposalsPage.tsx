import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useProposals } from '../hooks/useProposals'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { PROPOSAL_STATUS_LABELS } from '../lib/types'
import type { Role } from '../lib/types'

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  ai_generated: 'bg-indigo-50 text-indigo-700',
  in_review: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700',
  sent: 'bg-sky-50 text-sky-700',
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-bold text-gray-900">Proposals</h2>
        <div className="flex items-center gap-2">
          <input
            value={newWo}
            onChange={(e) => setNewWo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="Work order #"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newWo.trim()}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg px-3 py-2 hover:bg-indigo-700 disabled:opacity-50"
          >
            <Plus size={14} /> New Proposal
          </button>
        </div>
      </div>
      {createErr && <p className="text-sm text-red-600">{createErr}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-semibold">WO</th>
              <th className="px-4 py-3 font-semibold">Store</th>
              <th className="px-4 py-3 font-semibold">Dispatcher</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Version</th>
              <th className="px-4 py-3 font-semibold text-right">Price</th>
              <th className="px-4 py-3 font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="text-center text-gray-400 py-8">Loading...</td>
              </tr>
            )}
            {!loading &&
              proposals.map((p) => {
                const wo = wos.find((w) => w.wo === p.wo)
                return (
                  <tr
                    key={p.id}
                    className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/proposals/${p.id}`)}
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-900">{p.wo}</td>
                    <td className="px-4 py-2.5 text-gray-600">{wo?.client || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-600">{p.dispatcher_name || '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[p.status]}`}>
                        {PROPOSAL_STATUS_LABELS[p.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">v{p.version}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700">${p.subtotal_price.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">
                      {new Date(p.updated_at).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            {!loading && !proposals.length && (
              <tr>
                <td colSpan={7} className="text-center text-gray-400 py-8">No proposals yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
