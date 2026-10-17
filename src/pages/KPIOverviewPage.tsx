import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { computeDispatcherKPIs } from '../lib/kpi'

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

export function KPIOverviewPage() {
  const navigate = useNavigate()
  const { wos, loading: woLoading } = useWorkOrders()
  const { profiles, loading: pLoading } = useProfiles()

  const kpis = useMemo(() => computeDispatcherKPIs(wos, profiles), [wos, profiles])

  if (woLoading || pLoading) {
    return <p className="text-sm text-gray-400 py-8 text-center">Loading KPIs...</p>
  }

  if (!kpis.length) {
    return <p className="text-sm text-gray-400 py-8 text-center">No dispatcher activity yet to score.</p>
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {kpis.map((k) => (
        <div
          key={k.dispatcherName}
          onClick={() => navigate(`/dispatcher/${encodeURIComponent(k.dispatcherName)}`)}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4 cursor-pointer hover:shadow-md hover:border-indigo-200 transition-shadow"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold text-gray-900">{k.dispatcherName}</p>
              <p className="text-xs text-gray-400">{k.totalJobs} work orders</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-right">
                <p className="text-2xl font-bold text-indigo-600">{k.compositeScore.toFixed(0)}</p>
                <p className="text-xs text-gray-400">Composite</p>
              </div>
              <ChevronRight size={18} className="text-gray-300" />
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
  )
}
