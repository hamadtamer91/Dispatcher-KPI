import { useMemo } from 'react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { computeClientKPIs } from '../lib/kpi'

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 75 ? 'bg-emerald-500' : value >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span>{value.toFixed(0)}</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  )
}

export function ClientReportsPage() {
  const { wos, loading } = useWorkOrders()
  const clients = useMemo(() => computeClientKPIs(wos), [wos])

  if (loading) {
    return <p className="text-sm text-gray-400 py-8 text-center">Loading client reports...</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">
        Grouped by the Store field on each work order. Jobs with no store recorded are grouped under
        "Unassigned" — add a Store column to the sheet (as the last column) to populate this.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {clients.map((c) => (
          <div key={c.clientName} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-900">{c.clientName}</p>
                <p className="text-xs text-gray-400">{c.totalJobs} work orders</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-indigo-600">{c.compositeScore.toFixed(0)}</p>
                <p className="text-xs text-gray-400">Composite</p>
              </div>
            </div>
            <div className="space-y-2.5">
              <ScoreBar label="Profit" value={c.profitScore} />
              <ScoreBar label="Cost Control" value={c.costControlScore} />
              <ScoreBar label="Reassignment" value={c.reassignmentScore} />
              <ScoreBar label="Quality" value={c.qualityScore} />
            </div>
          </div>
        ))}
        {!clients.length && (
          <p className="text-sm text-gray-400 py-8 text-center col-span-full">No work orders yet.</p>
        )}
      </div>
    </div>
  )
}
