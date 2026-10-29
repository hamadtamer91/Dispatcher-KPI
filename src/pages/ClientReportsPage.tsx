import { useMemo } from 'react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { computeClientKPIs } from '../lib/kpi'
import { PageHeader, ScoreBar } from '../components/ui'

export function ClientReportsPage() {
  const { wos, loading } = useWorkOrders()
  const clients = useMemo(() => computeClientKPIs(wos), [wos])

  if (loading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading client reports...</p>
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Client Reports"
        description={'Grouped by the Client field on each work order, filled in automatically from the Excel tab/sheet name each work order synced from. Jobs with no client recorded are grouped under "Unassigned".'}
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {clients.map((c) => (
          <div key={c.clientName} className="tile p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-bold text-ink">{c.clientName}</p>
                <p className="text-xs text-ink-faint">{c.totalJobs} work orders</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-extrabold text-brand-700 tabular-nums">{c.compositeScore.toFixed(0)}</p>
                <p className="text-xs text-ink-faint">Composite</p>
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
          <p className="text-sm text-ink-faint py-8 text-center col-span-full">No work orders yet.</p>
        )}
      </div>
    </div>
  )
}
