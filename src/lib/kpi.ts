import type { Profile, WorkOrder } from './types'

export interface DispatcherKPI {
  dispatcherName: string
  totalJobs: number
  profitScore: number
  costControlScore: number
  reassignmentScore: number
  qualityScore: number
  clientScorecardScore: number
  compositeScore: number
  // Raw counts from the dedicated reassignment columns (Oct 2026) -- "from him" / "to him".
  reassignedFromCount: number
  reassignedToCount: number
}

function avg(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

// Statuses actually used in the live sheet that represent a job closed out successfully.
export const DONE_STATUSES = new Set(['job done', 'billed for incurred'])
// A status that represents a job that had to be reassigned to another dispatcher/sub.
// Not currently used anywhere in the live sheet, so this score defaults to 100 until
// a "Reassigned" status (or a dedicated reassignment column) is actually put to use.
export const REASSIGNED_STATUSES = new Set(['reassigned'])

/**
 * Composite KPI scoring across five dimensions, each 0-100:
 *  - Profit: average profit % across jobs (falls back to (nte-cost)/nte when profit_pct is blank)
 *  - Cost control: % of jobs that stayed at or under their NTE ceiling
 *  - Reassignment: 100 minus the % of jobs that were reassigned (fewer reassignments = higher score)
 *  - Quality: completion rate (jobs marked "Job Done" or "Billed For Incurred" over total assigned)
 *  - Client scorecard: the Super-Admin-entered App/IVR + system-usage scores from the dispatcher's profile
 */
export function computeDispatcherKPIs(workOrders: WorkOrder[], profiles: Profile[]): DispatcherKPI[] {
  const byDispatcher = new Map<string, WorkOrder[]>()
  for (const wo of workOrders) {
    const name = wo.dispatcher?.trim()
    if (!name) continue
    if (!byDispatcher.has(name)) byDispatcher.set(name, [])
    byDispatcher.get(name)!.push(wo)
  }
  // A dispatcher who lost every job to reassignment still needs a row, even though
  // none of their jobs are grouped under them anymore (the `dispatcher` column
  // always holds the *current* owner).
  for (const wo of workOrders) {
    for (const name of [wo.reassigned_from?.trim(), wo.reassigned_to?.trim()]) {
      if (name && !byDispatcher.has(name)) byDispatcher.set(name, [])
    }
  }

  const results: DispatcherKPI[] = []
  for (const [dispatcherName, jobs] of byDispatcher.entries()) {
    const profile = profiles.find((p) => p.dispatcher_name === dispatcherName)

    const profitValues = jobs
      .map((j) => {
        // profit_pct is stored in the sheet as a ratio (0.85 = 85% margin), not a 0-100 percentage.
        if (j.profit_pct !== null && j.profit_pct !== undefined) return j.profit_pct * 100
        if (j.nte && j.cost !== null && j.cost !== undefined && j.nte > 0) {
          return ((j.nte - j.cost) / j.nte) * 100
        }
        return null
      })
      .filter((v): v is number => v !== null)
    const profitScore = Math.max(0, Math.min(100, avg(profitValues)))

    const costJobs = jobs.filter((j) => j.cost !== null && j.nte !== null)
    const withinBudget = costJobs.filter((j) => (j.cost ?? 0) <= (j.nte ?? 0))
    const costControlScore = costJobs.length ? (withinBudget.length / costJobs.length) * 100 : 100

    const reassigned = jobs.filter((j) => REASSIGNED_STATUSES.has((j.status ?? '').toLowerCase()))
    const reassignmentScore = jobs.length ? 100 - (reassigned.length / jobs.length) * 100 : 100

    const done = jobs.filter((j) => DONE_STATUSES.has((j.status ?? '').toLowerCase()))
    const qualityScore = jobs.length ? (done.length / jobs.length) * 100 : 0

    const clientScorecardScore = profile
      ? avg([profile.app_ivr ?? 0, profile.system_usage ?? 0])
      : 0

    const compositeScore = avg([profitScore, costControlScore, reassignmentScore, qualityScore, clientScorecardScore])

    // Raw reassignment counts from the dedicated reassigned_from/reassigned_to columns,
    // checked against the FULL work order list (not just `jobs`) since a job reassigned
    // away from this dispatcher is no longer grouped under them.
    const reassignedFromCount = workOrders.filter((w) => w.reassigned_from?.trim() === dispatcherName).length
    const reassignedToCount = workOrders.filter((w) => w.reassigned_to?.trim() === dispatcherName).length

    results.push({
      dispatcherName,
      totalJobs: jobs.length,
      profitScore,
      costControlScore,
      reassignmentScore,
      qualityScore,
      clientScorecardScore,
      compositeScore,
      reassignedFromCount,
      reassignedToCount,
    })
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore)
}

export interface ClientKPI {
  clientName: string
  totalJobs: number
  profitScore: number
  costControlScore: number
  reassignmentScore: number
  qualityScore: number
  compositeScore: number
}

/**
 * Same scoring approach as computeDispatcherKPIs, grouped by client/account instead of
 * dispatcher. There's no "Client Scorecard" dimension here (that's a per-dispatcher
 * App/IVR + system-usage rating, not meaningful per client), so composite is the
 * average of the remaining four scores. Jobs with no client recorded are grouped
 * under "Unassigned".
 */
export function computeClientKPIs(workOrders: WorkOrder[]): ClientKPI[] {
  const byClient = new Map<string, WorkOrder[]>()
  for (const wo of workOrders) {
    const name = wo.client?.trim() || 'Unassigned'
    if (!byClient.has(name)) byClient.set(name, [])
    byClient.get(name)!.push(wo)
  }

  const results: ClientKPI[] = []
  for (const [clientName, jobs] of byClient.entries()) {
    const profitValues = jobs
      .map((j) => {
        if (j.profit_pct !== null && j.profit_pct !== undefined) return j.profit_pct * 100
        if (j.nte && j.cost !== null && j.cost !== undefined && j.nte > 0) {
          return ((j.nte - j.cost) / j.nte) * 100
        }
        return null
      })
      .filter((v): v is number => v !== null)
    const profitScore = Math.max(0, Math.min(100, avg(profitValues)))

    const costJobs = jobs.filter((j) => j.cost !== null && j.nte !== null)
    const withinBudget = costJobs.filter((j) => (j.cost ?? 0) <= (j.nte ?? 0))
    const costControlScore = costJobs.length ? (withinBudget.length / costJobs.length) * 100 : 100

    const reassigned = jobs.filter((j) => REASSIGNED_STATUSES.has((j.status ?? '').toLowerCase()))
    const reassignmentScore = jobs.length ? 100 - (reassigned.length / jobs.length) * 100 : 100

    const done = jobs.filter((j) => DONE_STATUSES.has((j.status ?? '').toLowerCase()))
    const qualityScore = jobs.length ? (done.length / jobs.length) * 100 : 0

    const compositeScore = avg([profitScore, costControlScore, reassignmentScore, qualityScore])

    results.push({
      clientName,
      totalJobs: jobs.length,
      profitScore,
      costControlScore,
      reassignmentScore,
      qualityScore,
      compositeScore,
    })
  }

  return results.sort((a, b) => b.totalJobs - a.totalJobs)
}

export interface CountDatum<K extends string> {
  label: string
  count: number
  key?: K
}

export interface ProfitBin {
  label: string
  count: number
  negative: boolean
}

export interface AnalyticsData {
  totalJobs: number
  totalDispatchers: number
  completionRate: number
  reassignmentRate: number
  statusCounts: CountDatum<string>[]
  dispatcherCounts: CountDatum<string>[]
  tradeCounts: CountDatum<string>[]
  clientCounts: CountDatum<string>[]
  monthlyCounts: { month: string; count: number }[]
  profitBins: ProfitBin[]
  budgetAdherence: { withinBudget: number; overBudget: number; noCostData: number }
}

const PROFIT_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '<0%', min: -Infinity, max: 0 },
  { label: '0-25%', min: 0, max: 25 },
  { label: '25-50%', min: 25, max: 50 },
  { label: '50-75%', min: 50, max: 75 },
  { label: '75-100%', min: 75, max: 100 },
  { label: '100%+', min: 100, max: Infinity },
]

/**
 * Work-order-level aggregates for the Analytics page: breakdowns by status, dispatcher,
 * trade, and month, plus a profit-margin histogram and budget-adherence split. This is
 * separate from computeDispatcherKPIs/computeClientKPIs, which score people/accounts --
 * this is raw counts and distributions across all work orders.
 */
export function computeAnalytics(workOrders: WorkOrder[]): AnalyticsData {
  const totalJobs = workOrders.length
  const dispatcherSet = new Set(
    workOrders.map((w) => w.dispatcher?.trim()).filter((v): v is string => Boolean(v))
  )

  const done = workOrders.filter((w) => DONE_STATUSES.has((w.status ?? '').toLowerCase()))
  const reassigned = workOrders.filter((w) => REASSIGNED_STATUSES.has((w.status ?? '').toLowerCase()))

  const tally = (values: (string | null | undefined)[]) => {
    const map = new Map<string, number>()
    for (const v of values) {
      const key = v?.trim() || 'Unknown'
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
  }

  const statusCounts = tally(workOrders.map((w) => w.status))
  const dispatcherCounts = tally(workOrders.map((w) => w.dispatcher)).filter((d) => d.label !== 'Unknown')
  const tradeCounts = tally(workOrders.map((w) => w.trade)).filter((t) => t.label !== 'Unknown')

  const clientMap = new Map<string, number>()
  for (const w of workOrders) {
    const key = w.client?.trim() || 'Unassigned'
    clientMap.set(key, (clientMap.get(key) ?? 0) + 1)
  }
  const clientCounts = [...clientMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)

  const monthMap = new Map<string, number>()
  for (const w of workOrders) {
    if (!w.wo_date) continue
    const month = w.wo_date.slice(0, 7)
    monthMap.set(month, (monthMap.get(month) ?? 0) + 1)
  }
  const monthlyCounts = [...monthMap.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))

  const profitBins: ProfitBin[] = PROFIT_BUCKETS.map((b) => ({ label: b.label, count: 0, negative: b.max <= 0 }))
  for (const w of workOrders) {
    if (w.profit_pct === null || w.profit_pct === undefined) continue
    const pct = w.profit_pct * 100
    const idx = PROFIT_BUCKETS.findIndex((b) => pct >= b.min && pct < b.max)
    profitBins[idx === -1 ? PROFIT_BUCKETS.length - 1 : idx].count++
  }

  const costJobs = workOrders.filter((w) => w.cost !== null && w.cost !== undefined && w.nte !== null && w.nte !== undefined)
  const withinBudget = costJobs.filter((w) => (w.cost ?? 0) <= (w.nte ?? 0)).length

  return {
    totalJobs,
    totalDispatchers: dispatcherSet.size,
    completionRate: totalJobs ? (done.length / totalJobs) * 100 : 0,
    reassignmentRate: totalJobs ? (reassigned.length / totalJobs) * 100 : 0,
    statusCounts,
    dispatcherCounts,
    tradeCounts,
    clientCounts,
    monthlyCounts,
    profitBins,
    budgetAdherence: {
      withinBudget,
      overBudget: costJobs.length - withinBudget,
      noCostData: totalJobs - costJobs.length,
    },
  }
}

// ---- Operational KPI expansion (Oct 2026) ----
// Missed ETA, late proposals, first-visit completion, assessment payments,
// reassignment counts, recalls, close-out speed, technicians sent, tech complaints.

/** Hours a proposal is allowed to go out after the first (actual) site visit before it's "late". */
export const PROPOSAL_SLA_HOURS = 24

function daysBetween(fromISODate: string, toISODate: string): number {
  return (new Date(toISODate).getTime() - new Date(fromISODate).getTime()) / 86_400_000
}

export interface OperationalKPIs {
  missedETA: { count: number; dataCount: number; rate: number }
  lateProposal: { onTime: number; late: number; pendingOverdue: number; dataCount: number; rate: number }
  firstVisit: { complete: number; dataCount: number; rate: number }
  assessment: { visits: number; feeTotal: number; paidCount: number; unpaidCount: number; unpaidAmount: number }
  reassignment: { reassignedAway: number; reassignedIn: number }
  recalls: { count: number; totalJobs: number; rate: number }
  closeOut: { avgDays: number | null; dataCount: number }
  technicians: { avgSent: number | null; dataCount: number }
  complaints: { count: number; dataCount: number; rate: number }
}

/**
 * Aggregate the nine new operational KPIs across whatever slice of work orders is
 * passed in -- the whole sheet for the Analytics page, or one dispatcher's jobs for
 * their detail page. Every metric is computed only over jobs that actually have the
 * relevant field filled in (`dataCount`), since most of this data is being collected
 * from this point forward and older rows will be blank.
 */
export function computeOperationalKPIs(workOrders: WorkOrder[]): OperationalKPIs {
  // Missed ETA: actual visit happened after the scheduled ETA date.
  const etaJobs = workOrders.filter((w) => w.eta && w.actual_visit_date)
  const missedETAJobs = etaJobs.filter((w) => daysBetween(w.eta!, w.actual_visit_date!) > 0)

  // Late proposal: due within PROPOSAL_SLA_HOURS of the actual visit. Dates are
  // day-granularity, so the 24h SLA is applied as "must go out same day or the next
  // calendar day" -- sent 2+ days after the visit counts as late.
  const slaDays = PROPOSAL_SLA_HOURS / 24
  const proposalJobs = workOrders.filter((w) => w.actual_visit_date)
  const todayISO = new Date().toISOString().slice(0, 10)
  let onTime = 0
  let late = 0
  let pendingOverdue = 0
  for (const w of proposalJobs) {
    if (w.quote_sent_on) {
      if (daysBetween(w.actual_visit_date!, w.quote_sent_on) > slaDays) late++
      else onTime++
    } else if (daysBetween(w.actual_visit_date!, todayISO) > slaDays) {
      pendingOverdue++
    }
  }
  const decided = onTime + late

  // First-visit completion.
  const firstVisitJobs = workOrders.filter((w) => w.first_visit_complete !== null && w.first_visit_complete !== undefined)
  const firstVisitComplete = firstVisitJobs.filter((w) => w.first_visit_complete === true)

  // Assessment visit payments.
  const assessmentJobs = workOrders.filter((w) => w.is_assessment_visit)
  const feeTotal = assessmentJobs.reduce((s, w) => s + (w.assessment_fee ?? 0), 0)
  const paidJobs = assessmentJobs.filter((w) => w.assessment_paid_on)
  const unpaidJobs = assessmentJobs.filter((w) => (w.assessment_fee ?? 0) > 0 && !w.assessment_paid_on)
  const unpaidAmount = unpaidJobs.reduce((s, w) => s + (w.assessment_fee ?? 0), 0)

  // Reassignments, from the dedicated columns (not the "Reassigned" status).
  const reassignedAway = workOrders.filter((w) => w.reassigned_from).length
  const reassignedIn = workOrders.filter((w) => w.reassigned_to).length

  // Recalls: a job that is itself a redo of an earlier WO.
  const recallJobs = workOrders.filter((w) => w.recall_of_wo)

  // Close-out speed: closed_on minus job_completed_on.
  const closeJobs = workOrders.filter((w) => w.job_completed_on && w.closed_on)
  const avgCloseDays = closeJobs.length
    ? avg(closeJobs.map((w) => daysBetween(w.job_completed_on!, w.closed_on!)))
    : null

  // Technicians sent per job (crew size).
  const techCountJobs = workOrders.filter((w) => w.technicians_count !== null && w.technicians_count !== undefined)
  const avgTechniciansSent = techCountJobs.length ? avg(techCountJobs.map((w) => w.technicians_count!)) : null

  // Technician complaints.
  const complaintDataJobs = workOrders.filter((w) => w.tech_complaint !== null && w.tech_complaint !== undefined)
  const complaintJobs = complaintDataJobs.filter((w) => w.tech_complaint === true)

  return {
    missedETA: {
      count: missedETAJobs.length,
      dataCount: etaJobs.length,
      rate: etaJobs.length ? (missedETAJobs.length / etaJobs.length) * 100 : 0,
    },
    lateProposal: {
      onTime,
      late,
      pendingOverdue,
      dataCount: proposalJobs.length,
      rate: decided ? (late / decided) * 100 : 0,
    },
    firstVisit: {
      complete: firstVisitComplete.length,
      dataCount: firstVisitJobs.length,
      rate: firstVisitJobs.length ? (firstVisitComplete.length / firstVisitJobs.length) * 100 : 0,
    },
    assessment: {
      visits: assessmentJobs.length,
      feeTotal,
      paidCount: paidJobs.length,
      unpaidCount: unpaidJobs.length,
      unpaidAmount,
    },
    reassignment: { reassignedAway, reassignedIn },
    recalls: {
      count: recallJobs.length,
      totalJobs: workOrders.length,
      rate: workOrders.length ? (recallJobs.length / workOrders.length) * 100 : 0,
    },
    closeOut: { avgDays: avgCloseDays, dataCount: closeJobs.length },
    technicians: { avgSent: avgTechniciansSent, dataCount: techCountJobs.length },
    complaints: {
      count: complaintJobs.length,
      dataCount: complaintDataJobs.length,
      rate: complaintDataJobs.length ? (complaintJobs.length / complaintDataJobs.length) * 100 : 0,
    },
  }
}

export interface TechnicianKPI {
  technicianName: string
  totalJobs: number
  complaintCount: number
  complaintDataCount: number
  complaintRate: number
  recallCount: number
  recallRate: number
  firstVisitRate: number
}

/**
 * Per-technician breakdown -- technicians are independent subcontractors, not system
 * users, so this groups by the free-text technician_name field rather than a profile.
 */
export function computeTechnicianKPIs(workOrders: WorkOrder[]): TechnicianKPI[] {
  const byTech = new Map<string, WorkOrder[]>()
  for (const w of workOrders) {
    const name = w.technician_name?.trim()
    if (!name) continue
    if (!byTech.has(name)) byTech.set(name, [])
    byTech.get(name)!.push(w)
  }

  const results: TechnicianKPI[] = []
  for (const [technicianName, jobs] of byTech.entries()) {
    const complaintDataJobs = jobs.filter((w) => w.tech_complaint !== null && w.tech_complaint !== undefined)
    const complaintJobs = complaintDataJobs.filter((w) => w.tech_complaint === true)
    const recallJobs = jobs.filter((w) => w.recall_of_wo)
    const firstVisitJobs = jobs.filter((w) => w.first_visit_complete !== null && w.first_visit_complete !== undefined)
    const firstVisitComplete = firstVisitJobs.filter((w) => w.first_visit_complete === true)

    results.push({
      technicianName,
      totalJobs: jobs.length,
      complaintCount: complaintJobs.length,
      complaintDataCount: complaintDataJobs.length,
      complaintRate: complaintDataJobs.length ? (complaintJobs.length / complaintDataJobs.length) * 100 : 0,
      recallCount: recallJobs.length,
      recallRate: jobs.length ? (recallJobs.length / jobs.length) * 100 : 0,
      firstVisitRate: firstVisitJobs.length ? (firstVisitComplete.length / firstVisitJobs.length) * 100 : 0,
    })
  }

  return results.sort((a, b) => b.totalJobs - a.totalJobs)
}
