import { useMemo } from 'react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { kpiScopeNames } from '../lib/permissions'
import {
  computeAnalytics,
  computeDispatcherKPIs,
  computeOperationalKPIs,
  computeTechnicianKPIs,
  DONE_STATUSES,
  REASSIGNED_STATUSES,
} from '../lib/kpi'
import { StatTile, ChartCard, HBarChart, Histogram, TrendLine, Legend, CHART_COLORS, formatMonth } from '../components/charts'
import { PageHeader } from '../components/ui'

const SCORE_BUCKETS = [
  { label: '0-20', min: 0, max: 20 },
  { label: '20-40', min: 20, max: 40 },
  { label: '40-60', min: 40, max: 60 },
  { label: '60-80', min: 60, max: 80 },
  { label: '80-100', min: 80, max: 101 },
]

export function AnalyticsPage() {
  const { profile: viewer } = useEntityScope()
  const { wos: allWos, loading: woLoading } = useWorkOrders()
  const { profiles, loading: pLoading } = useProfiles()

  // A dispatcher already only receives their own jobs and a team leader gets
  // narrowed to their team's here; everyone else sees every work order.
  const scopeNames = useMemo(() => kpiScopeNames(viewer, profiles), [viewer, profiles])
  const wos = useMemo(
    () => (scopeNames ? allWos.filter((w) => scopeNames.has(w.dispatcher?.trim() ?? '')) : allWos),
    [allWos, scopeNames],
  )

  const analytics = useMemo(() => computeAnalytics(wos), [wos])
  const kpis = useMemo(() => {
    const all = computeDispatcherKPIs(wos, profiles)
    return scopeNames ? all.filter((k) => scopeNames.has(k.dispatcherName)) : all
  }, [wos, profiles, scopeNames])
  const ops = useMemo(() => computeOperationalKPIs(wos), [wos])
  const techKpis = useMemo(() => computeTechnicianKPIs(wos), [wos])

  const scoreHistogram = useMemo(() => {
    const bins = SCORE_BUCKETS.map((b) => ({ label: b.label, value: 0 }))
    for (const k of kpis) {
      const idx = SCORE_BUCKETS.findIndex((b) => k.compositeScore >= b.min && k.compositeScore < b.max)
      bins[idx === -1 ? bins.length - 1 : idx].value++
    }
    return bins
  }, [kpis])

  const avgComposite = kpis.length ? kpis.reduce((a, k) => a + k.compositeScore, 0) / kpis.length : 0

  if (woLoading || pLoading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading analytics...</p>
  }

  if (!analytics.totalJobs) {
    return <p className="text-sm text-ink-faint py-8 text-center">No work orders yet to analyze.</p>
  }

  const statusBars = analytics.statusCounts.map((s) => {
    const lower = s.label.toLowerCase()
    const color = DONE_STATUSES.has(lower)
      ? CHART_COLORS.good
      : REASSIGNED_STATUSES.has(lower)
        ? CHART_COLORS.critical
        : CHART_COLORS.gray
    return { label: s.label, value: s.count, color }
  })

  const dispatcherBars = analytics.dispatcherCounts.map((d) => ({ label: d.label, value: d.count }))
  const tradeBars = analytics.tradeCounts.map((t) => ({ label: t.label, value: t.count }))

  const profitBins = analytics.profitBins.map((b) => ({
    label: b.label,
    value: b.count,
    color: b.negative ? CHART_COLORS.divergingRed : CHART_COLORS.blue,
  }))
  const profitDataCount = analytics.profitBins.reduce((a, b) => a + b.count, 0)

  const budgetBars = [
    { label: 'Within Budget', value: analytics.budgetAdherence.withinBudget, color: CHART_COLORS.good },
    { label: 'Over Budget', value: analytics.budgetAdherence.overBudget, color: CHART_COLORS.critical },
  ]

  const monthlyTrend = analytics.monthlyCounts.map((m) => ({ label: formatMonth(m.month), value: m.count }))

  const complaintBars = techKpis
    .filter((t) => t.complaintDataCount > 0)
    .sort((a, b) => b.complaintRate - a.complaintRate)
    .slice(0, 10)
    .map((t) => ({
      label: t.technicianName,
      value: Math.round(t.complaintRate),
      color: t.complaintRate >= 25 ? CHART_COLORS.critical : t.complaintRate > 0 ? CHART_COLORS.orange : CHART_COLORS.good,
    }))

  const recallBars = techKpis
    .filter((t) => t.totalJobs > 0)
    .sort((a, b) => b.recallRate - a.recallRate)
    .slice(0, 10)
    .map((t) => ({
      label: t.technicianName,
      value: Math.round(t.recallRate),
      color: t.recallRate >= 25 ? CHART_COLORS.critical : t.recallRate > 0 ? CHART_COLORS.orange : CHART_COLORS.good,
    }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={
          viewer.role === 'dispatcher'
            ? 'How your own jobs are performing.'
            : viewer.role === 'team_leader'
              ? "How your team's jobs are performing."
              : 'How the whole operation is performing, across every work order on file.'
        }
      />

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total Work Orders" value={analytics.totalJobs} />
        <StatTile label="Active Dispatchers" value={analytics.totalDispatchers} />
        <StatTile label="Completion Rate" value={`${analytics.completionRate.toFixed(0)}%`} hint="Job Done + Billed For Incurred" />
        <StatTile label="Avg Composite Score" value={avgComposite.toFixed(0)} hint={`across ${kpis.length} dispatchers`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Work Orders by Status" subtitle="Where every job currently sits in the pipeline">
          <HBarChart data={statusBars} />
          <Legend
            items={[
              { label: 'Completed', color: CHART_COLORS.good },
              { label: 'Reassigned', color: CHART_COLORS.critical },
              { label: 'In progress', color: CHART_COLORS.gray },
            ]}
          />
        </ChartCard>

        <ChartCard title="Workload by Dispatcher" subtitle="Total work orders assigned, all-time">
          <HBarChart data={dispatcherBars} />
        </ChartCard>

        <ChartCard title="Jobs by Trade" subtitle="Which trades make up the work order volume">
          <HBarChart data={tradeBars} />
        </ChartCard>

        <ChartCard title="Composite KPI Score Distribution" subtitle="How many dispatchers fall into each score band">
          <Histogram bins={scoreHistogram} />
        </ChartCard>

        <ChartCard
          title="Profit Margin Distribution"
          subtitle={profitDataCount ? `Across ${profitDataCount} jobs with profit data recorded` : 'No jobs have profit data recorded yet'}
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

        <div className="lg:col-span-2">
          <ChartCard title="Monthly Work Order Volume" subtitle="New work orders opened per month">
            <TrendLine points={monthlyTrend} />
          </ChartCard>
        </div>
      </div>

      <div className="pt-2 border-t border-line">
        <h2 className="text-base font-bold text-ink mt-4 mb-3">Operational KPIs</h2>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
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
            label="Reassigned (Away / In)"
            value={`${ops.reassignment.reassignedAway} / ${ops.reassignment.reassignedIn}`}
            hint="Jobs with a recorded reassignment"
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
        <ChartCard title="Complaint Rate by Technician" subtitle="Top 10 technicians by complaint rate, among those with recorded complaint data">
          <HBarChart data={complaintBars} unit="%" emptyText="No technician complaint data recorded yet." />
        </ChartCard>
        <ChartCard title="Recall Rate by Technician" subtitle="Top 10 technicians by recall rate">
          <HBarChart data={recallBars} unit="%" emptyText="No technician data recorded yet." />
        </ChartCard>
      </div>
    </div>
  )
}
