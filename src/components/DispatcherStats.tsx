// The KPI tiles + chart grid for a single dispatcher's work orders. Shared between the
// admin's per-dispatcher detail page and the dispatcher's own "My Jobs" view -- `selfView`
// just swaps a couple of chart subtitles from third-person ("this dispatcher's jobs") to
// first-person ("your jobs") phrasing.
import { useMemo } from 'react'
import { computeAnalytics, computeOperationalKPIs, DONE_STATUSES, REASSIGNED_STATUSES } from '../lib/kpi'
import type { DispatcherKPI } from '../lib/kpi'
import type { Profile, WorkOrder } from '../lib/types'
import { StatTile, ChartCard, HBarChart, Histogram, TrendLine, Legend, CHART_COLORS, formatMonth } from './charts'

export function DispatcherStats({
  workOrders,
  kpi,
  profile,
  selfView = false,
}: {
  workOrders: WorkOrder[]
  kpi: DispatcherKPI
  profile?: Profile | null
  selfView?: boolean
}) {
  const analytics = useMemo(() => computeAnalytics(workOrders), [workOrders])
  const ops = useMemo(() => computeOperationalKPIs(workOrders), [workOrders])

  const costJobs = workOrders.filter((w) => w.cost !== null && w.nte !== null)
  const profitJobs = workOrders.filter((w) => w.profit_pct !== null && w.profit_pct !== undefined)

  const jobsLabel = selfView ? 'your' : "this dispatcher's"
  const handleLabel = selfView ? 'you handle' : 'this dispatcher handles'

  const statusBars = analytics.statusCounts.map((s) => {
    const lower = s.label.toLowerCase()
    const color = DONE_STATUSES.has(lower)
      ? CHART_COLORS.good
      : REASSIGNED_STATUSES.has(lower)
        ? CHART_COLORS.critical
        : CHART_COLORS.gray
    return { label: s.label, value: s.count, color }
  })
  const tradeBars = analytics.tradeCounts.map((t) => ({ label: t.label, value: t.count }))
  const clientBars = analytics.clientCounts.map((c) => ({ label: c.label, value: c.count }))
  const profitBins = analytics.profitBins.map((b) => ({
    label: b.label,
    value: b.count,
    color: b.negative ? CHART_COLORS.divergingRed : CHART_COLORS.blue,
  }))
  const budgetBars = [
    { label: 'Within Budget', value: analytics.budgetAdherence.withinBudget, color: CHART_COLORS.good },
    { label: 'Over Budget', value: analytics.budgetAdherence.overBudget, color: CHART_COLORS.critical },
  ]
  const monthlyTrend = analytics.monthlyCounts.map((m) => ({ label: formatMonth(m.month), value: m.count }))

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Profit"
          value={kpi.profitScore.toFixed(0)}
          hint={`from ${profitJobs.length} of ${workOrders.length} jobs with profit data`}
        />
        <StatTile
          label="Cost Control"
          value={kpi.costControlScore.toFixed(0)}
          hint={`${costJobs.filter((j) => (j.cost ?? 0) <= (j.nte ?? 0)).length} of ${costJobs.length} jobs at/under NTE`}
        />
        <StatTile
          label="Reassignment"
          value={kpi.reassignmentScore.toFixed(0)}
          hint="100 = no reassignments"
        />
        <StatTile
          label="Quality"
          value={kpi.qualityScore.toFixed(0)}
          hint="% marked Job Done / Billed For Incurred"
        />
        <StatTile
          label="Client Scorecard"
          value={kpi.clientScorecardScore.toFixed(0)}
          hint={profile ? 'App/IVR + system usage' : 'No login profile linked yet'}
        />
      </div>

      <div className="pt-2 border-t border-line">
        <h3 className="text-base font-bold text-ink mt-4 mb-3">Operational KPIs</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile
            label="Missed ETA"
            value={`${ops.missedETA.rate.toFixed(0)}%`}
            hint={ops.missedETA.dataCount ? `${ops.missedETA.count} of ${ops.missedETA.dataCount} visits ran past ETA` : 'No ETA + visit data yet'}
          />
          <StatTile
            label="Late Proposals"
            value={`${ops.lateProposal.rate.toFixed(0)}%`}
            hint={`${ops.lateProposal.late} late, ${ops.lateProposal.onTime} on time (24h SLA)${ops.lateProposal.pendingOverdue ? `, ${ops.lateProposal.pendingOverdue} pending overdue` : ''}`}
          />
          <StatTile
            label="Job Done on First Visit"
            value={`${ops.firstVisit.rate.toFixed(0)}%`}
            hint={ops.firstVisit.dataCount ? `${ops.firstVisit.complete} of ${ops.firstVisit.dataCount} jobs` : 'No data recorded yet'}
          />
          <StatTile
            label="Assessment Fees Outstanding"
            value={`$${ops.assessment.unpaidAmount.toFixed(0)}`}
            hint={`${ops.assessment.unpaidCount} unpaid of ${ops.assessment.visits} assessment visits`}
          />
          <StatTile
            label="Reassigned (From / To)"
            value={`${kpi.reassignedFromCount} / ${kpi.reassignedToCount}`}
            hint={selfView ? 'Jobs reassigned away from you / to you' : "Jobs reassigned away from / to this dispatcher"}
          />
          <StatTile
            label="Recalls"
            value={`${ops.recalls.rate.toFixed(1)}%`}
            hint={`${ops.recalls.count} of ${ops.recalls.totalJobs} jobs are recalls`}
          />
          <StatTile
            label="Close-Out Speed"
            value={ops.closeOut.avgDays !== null ? `${ops.closeOut.avgDays.toFixed(1)} days` : '—'}
            hint={ops.closeOut.dataCount ? `avg across ${ops.closeOut.dataCount} closed jobs` : 'No close-out dates recorded yet'}
          />
          <StatTile
            label="Avg Technicians Sent"
            value={ops.technicians.avgSent !== null ? ops.technicians.avgSent.toFixed(1) : '—'}
            hint={ops.technicians.dataCount ? `avg across ${ops.technicians.dataCount} jobs` : 'No data recorded yet'}
          />
          <StatTile
            label="Tech Complaints"
            value={`${ops.complaints.rate.toFixed(1)}%`}
            hint={ops.complaints.dataCount ? `${ops.complaints.count} of ${ops.complaints.dataCount} jobs` : 'No data recorded yet'}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Jobs by Status" subtitle={`Where ${jobsLabel} jobs currently sit in the pipeline`}>
          <HBarChart data={statusBars} />
          <Legend
            items={[
              { label: 'Completed', color: CHART_COLORS.good },
              { label: 'Reassigned', color: CHART_COLORS.critical },
              { label: 'In progress', color: CHART_COLORS.gray },
            ]}
          />
        </ChartCard>

        <ChartCard title="Jobs by Trade" subtitle={`Which trades ${handleLabel} most`}>
          <HBarChart data={tradeBars} />
        </ChartCard>

        <ChartCard title="Jobs by Client" subtitle="Grouped by the Client field on each work order">
          <HBarChart data={clientBars} />
        </ChartCard>

        <ChartCard
          title="Profit Margin Distribution"
          subtitle={profitJobs.length ? `Across ${profitJobs.length} jobs with profit data recorded` : 'No jobs have profit data recorded yet'}
        >
          <Histogram bins={profitBins} />
          <Legend
            items={[
              { label: 'Loss (<0% margin)', color: CHART_COLORS.divergingRed },
              { label: 'Profitable', color: CHART_COLORS.blue },
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Budget Adherence"
          subtitle={
            analytics.budgetAdherence.noCostData
              ? `${analytics.budgetAdherence.noCostData} jobs have no cost data yet and are excluded`
              : 'Jobs where cost stayed at or under the NTE ceiling'
          }
        >
          <HBarChart data={budgetBars} />
        </ChartCard>

        <ChartCard title="Monthly Job Volume" subtitle="Work orders opened per month">
          <TrendLine points={monthlyTrend} />
        </ChartCard>
      </div>
    </div>
  )
}
