import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { computeDispatcherKPIs } from '../lib/kpi'
import { kpiScopeNames } from '../lib/permissions'
import { PageHeader, ScoreBar, EmptyState } from '../components/ui'

export function KPIOverviewPage() {
  const navigate = useNavigate()
  const { profile: viewer } = useEntityScope()
  const { wos, loading: woLoading } = useWorkOrders()
  const { profiles, loading: pLoading } = useProfiles()

  // A dispatcher only sees their own card and a team leader only their own
  // team's; everyone else sees every dispatcher in the entity.
  const scopeNames = useMemo(() => kpiScopeNames(viewer, profiles), [viewer, profiles])
  const kpis = useMemo(() => {
    const all = computeDispatcherKPIs(wos, profiles)
    return scopeNames ? all.filter((k) => scopeNames.has(k.dispatcherName)) : all
  }, [wos, profiles, scopeNames])

  if (woLoading || pLoading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading KPIs...</p>
  }

  const description =
    viewer.role === 'dispatcher'
      ? 'Your scorecard — open it for the full breakdown.'
      : viewer.role === 'team_leader'
        ? "Your team's dispatcher scorecards — open one for the full breakdown."
        : 'Composite dispatcher scorecards — open one for the full breakdown.'

  return (
    <div>
      <PageHeader title="KPI Overview" description={description} />

      {!kpis.length ? (
        <EmptyState>
          {viewer.role === 'team_leader' && !scopeNames?.size
            ? 'No dispatchers are on your team yet. Ask an Admin to assign them to you in Manage Users.'
            : 'No dispatcher activity yet to score.'}
        </EmptyState>
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
