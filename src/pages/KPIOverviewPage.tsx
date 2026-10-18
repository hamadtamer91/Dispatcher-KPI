import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { computeDispatcherKPIs } from '../lib/kpi'
import { PageHeader, ScoreBar, EmptyState } from '../components/ui'

export function KPIOverviewPage() {
  const navigate = useNavigate()
  const { wos, loading: woLoading } = useWorkOrders()
  const { profiles, loading: pLoading } = useProfiles()

  const kpis = useMemo(() => computeDispatcherKPIs(wos, profiles), [wos, profiles])

  if (woLoading || pLoading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading KPIs...</p>
  }

  return (
    <div>
      <PageHeader title="KPI Overview" description="Composite dispatcher scorecards — open one for the full breakdown." />

      {!kpis.length ? (
        <EmptyState>No dispatcher activity yet to score.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {kpis.map((k) => (
            <div
              key={k.dispatcherName}
              onClick={() => navigate(`/dispatcher/${encodeURIComponent(k.dispatcherName)}`)}
              className="tile tile-interactive p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-ink">{k.dispatcherName}</p>
                  <p className="text-xs text-ink-faint">{k.totalJobs} work orders</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-2xl font-extrabold text-brand-700 tabular-nums">{k.compositeScore.toFixed(0)}</p>
                    <p className="text-xs text-ink-faint">Composite</p>
                  </div>
                  <ChevronRight size={18} className="text-ink-faint" />
                </div>
              </div>
              <div className="space-y-2.5">
                <ScoreBar label="Profit" value={k.profitScore} />
                <ScoreBar label="Cost Control" value={k.costControlScore} />
                <ScoreBar label="Reassignment" value={k.reassignmentScore} />
                <ScoreBar label="Quality" value={k.qualityScore} />
                <ScoreBar label="Client Scorecard" value={k.clientScorecardScore} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
