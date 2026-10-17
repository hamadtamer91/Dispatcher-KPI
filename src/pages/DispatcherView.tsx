import { useMemo } from 'react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { computeDispatcherKPIs, DONE_STATUSES } from '../lib/kpi'
import { DispatcherStats } from '../components/DispatcherStats'
import { WorkOrdersMap } from '../components/WorkOrdersMap'
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

const TONE_STYLES: Record<DueTone, string> = {
  overdue: 'bg-red-50 text-red-700 border-red-200',
  today: 'bg-amber-50 text-amber-700 border-amber-200',
  upcoming: 'bg-gray-50 text-gray-600 border-gray-200',
  none: 'bg-gray-50 text-gray-400 border-gray-200',
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
      <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-4">
        Your profile isn't linked to a dispatcher name yet. Ask a Super Admin to set it in Manage Users.
      </p>
    )
  }

  if (loading) {
    return <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Hi, {dispatcherName}</h2>
          <p className="text-sm text-gray-400">{mine.length} work orders total · {myOpenJobs.length} open</p>
        </div>
        {kpi && (
          <div className="text-right">
            <p className="text-3xl font-bold text-indigo-600">{kpi.compositeScore.toFixed(0)}</p>
            <p className="text-xs text-gray-400">Composite score</p>
          </div>
        )}
      </div>

      <div>
        <p className="text-sm font-semibold text-gray-700 mb-3">My Open Jobs</p>
        {!myOpenJobs.length && (
          <p className="text-sm text-gray-400 bg-white border border-gray-200 rounded-xl p-6 text-center">
            Nothing open right now — you're all caught up.
          </p>
        )}
        {myOpenJobs.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100">
            {myOpenJobs.map((w) => {
              const due = dueLabel(w.eta, today)
              return (
                <div key={w.wo} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900 text-sm">WO {w.wo}</span>
                      <span className="text-xs text-gray-400">{w.status || 'Unknown'}</span>
                    </div>
                    <p className="text-xs text-gray-500 truncate">
                      {w.client || 'Unassigned'}
                      {w.trade && <> · {w.trade}</>}
                      {(w.address || w.city) && <> · {[w.address, w.city, w.state].filter(Boolean).join(', ')}</>}
                    </p>
                  </div>
                  <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full border whitespace-nowrap ${TONE_STYLES[due.tone]}`}>
                    {due.text}
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
            <p className="text-sm font-semibold text-gray-700 mb-3">My Jobs on the Map</p>
            <WorkOrdersMap workOrders={mine} height={420} />
          </div>
        </>
      )}

      <div>
        <p className="text-sm font-semibold text-gray-700 mb-3">All My Work Orders</p>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                {COLUMNS.map((c) => <th key={c} className="px-4 py-3 font-semibold">{c.replace(/_/g, ' ')}</th>)}
              </tr>
            </thead>
            <tbody>
              {mine.map((w) => (
                <tr key={w.wo} className="border-b border-gray-100 hover:bg-gray-50">
                  {COLUMNS.map((c) => <td key={c} className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{String(w[c] ?? '—')}</td>)}
                </tr>
              ))}
              {!mine.length && (
                <tr><td colSpan={COLUMNS.length} className="text-center text-gray-400 py-8">No work orders assigned to you yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
