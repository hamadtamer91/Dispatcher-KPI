import { useMemo } from 'react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { computeDispatcherKPIs, DONE_STATUSES } from '../lib/kpi'
import { DispatcherStats } from '../components/DispatcherStats'
import { WorkOrdersMap } from '../components/WorkOrdersMap'
import { Badge, EmptyState, PageHeader } from '../components/ui'
import type { BadgeVariant } from '../components/ui'
import type { WorkOrder } from '../lib/types'

const COLUMNS: (keyof WorkOrder)[] = ['wo', 'status', 'wo_date', 'eta', 'trade', 'city', 'state', 'nte']

/** Today's date as a local YYYY-MM-DD string. Deliberately not `toISOString().slice(0,10)`,
 *  which reads UTC and would show "tomorrow" as still today (or vice versa) for anyone
 *  west/east of UTC for part of the day. */
function todayLocalISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type DueTone = 'overdue' | 'today' | 'upcoming' | 'none'

function dueLabel(eta: string | null, today: string): { text: string; tone: DueTone } {
  if (!eta) return { text: 'No ETA', tone: 'none' }
  if (eta < today) return { text: `Overdue · was due ${eta}`, tone: 'overdue' }
  if (eta === today) return { text: 'Due today', tone: 'today' }
  return { text: `Due ${eta}`, tone: 'upcoming' }
}

const TONE_VARIANT: Record<DueTone, BadgeVariant> = {
  overdue: 'danger',
  today: 'warn',
  upcoming: 'neutral',
  none: 'neutral',
}

export function DispatcherView({ dispatcherName }: { dispatcherName: string | null }) {
  const { wos, loading: woLoading } = useWorkOrders()
  const { profiles, loading: pLoading } = useProfiles()

  const mine = useMemo(
    () => wos.filter((w) => w.dispatcher?.trim() === dispatcherName),
    [wos, dispatcherName]
  )
  const kpi = useMemo(
    () => computeDispatcherKPIs(wos, profiles).find((k) => k.dispatcherName === dispatcherName),
    [wos, profiles, dispatcherName]
  )
  const profile = useMemo(
    () => profiles.find((p) => p.dispatcher_name === dispatcherName),
    [profiles, dispatcherName]
  )

  const today = todayLocalISO()
  const myOpenJobs = useMemo(() => {
    return mine
      .filter((w) => !DONE_STATUSES.has((w.status ?? '').toLowerCase()))
      .sort((a, b) => {
        if (!a.eta && !b.eta) return 0
        if (!a.eta) return 1
        if (!b.eta) return -1
        return a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : 0
      })
  }, [mine])

  const loading = woLoading || pLoading

  if (!dispatcherName) {
    return (
      <p className="text-sm text-warn bg-warn-tint border border-warn/20 rounded-lg p-4">
        Your profile isn't linked to a dispatcher name yet. Ask a Super Admin to set it in Manage Users.
      </p>
    )
  }

  if (loading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Hi, ${dispatcherName}`}
        description={`${mine.length} work orders total · ${myOpenJobs.length} open`}
        actions={
          kpi && (
            <div className="text-right">
              <p className="text-3xl font-extrabold text-brand-700 tabular-nums">{kpi.compositeScore.toFixed(0)}</p>
              <p className="text-xs text-ink-faint">Composite score</p>
            </div>
          )
        }
      />

      <div>
        <p className="text-sm font-bold text-ink mb-3">My Open Jobs</p>
        {!myOpenJobs.length && <EmptyState>Nothing open right now — you're all caught up.</EmptyState>}
        {myOpenJobs.length > 0 && (
          <div className="panel divide-y divide-line">
            {myOpenJobs.map((w) => {
              const due = dueLabel(w.eta, today)
              return (
                <div key={w.wo} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink text-sm">WO {w.wo}</span>
                      <span className="text-xs text-ink-faint">{w.status || 'Unknown'}</span>
                    </div>
                    <p className="text-xs text-ink-soft truncate">
                      {w.client || 'Unassigned'}
                      {w.trade && <> · {w.trade}</>}
                      {(w.address || w.city) && <> · {[w.address, w.city, w.state].filter(Boolean).join(', ')}</>}
                    </p>
                  </div>
                  <span className="shrink-0">
                    <Badge variant={TONE_VARIANT[due.tone]}>{due.text}</Badge>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {kpi && (
        <>
          <DispatcherStats workOrders={mine} kpi={kpi} profile={profile} selfView />

          <div>
            <p className="text-sm font-bold text-ink mb-3">My Jobs on the Map</p>
            <WorkOrdersMap workOrders={mine} height={420} />
          </div>
        </>
      )}

      <div>
        <p className="text-sm font-bold text-ink mb-3">All My Work Orders</p>
        <div className="panel overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="table-head-row">
                {COLUMNS.map((c) => <th key={c} className="px-4 py-3">{c.replace(/_/g, ' ')}</th>)}
              </tr>
            </thead>
            <tbody>
              {mine.map((w) => (
                <tr key={w.wo} className="table-row">
                  {COLUMNS.map((c) => <td key={c} className="px-4 py-2.5 text-ink-soft whitespace-nowrap">{String(w[c] ?? '—')}</td>)}
                </tr>
              ))}
              {!mine.length && (
                <tr><td colSpan={COLUMNS.length} className="text-center text-ink-faint py-8">No work orders assigned to you yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
