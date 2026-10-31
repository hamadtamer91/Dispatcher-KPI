import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { computeDispatcherKPIs } from '../lib/kpi'
import { kpiScopeNames } from '../lib/permissions'
import type { WorkOrder } from '../lib/types'
import { DispatcherStats } from '../components/DispatcherStats'
import { WorkOrdersMap } from '../components/WorkOrdersMap'
import { PageHeader } from '../components/ui'

const DETAIL_COLUMNS: (keyof WorkOrder)[] = [
  'wo', 'status', 'client', 'wo_date', 'eta', 'trade', 'subtrade',
  'city', 'state', 'nte', 'nte_approved', 'cost', 'profit_pct',
  'quote_sent_on', 'invoiced_on',
]

const COLUMN_LABELS: Partial<Record<keyof WorkOrder, string>> = {
  client: 'Client',
}

function columnLabel(c: keyof WorkOrder): string {
  return COLUMN_LABELS[c] ?? c.replace(/_/g, ' ')
}

export function DispatcherDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const dispatcherName = decodeURIComponent(name ?? '')
  const { profile: viewer } = useEntityScope()
  const { wos, loading: woLoading } = useWorkOrders()
  const { profiles, loading: pLoading } = useProfiles()
  const scopeNames = useMemo(() => kpiScopeNames(viewer, profiles), [viewer, profiles])

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

  if (woLoading || pLoading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading...</p>
  }

  const backButton = (
    <button
      onClick={() => navigate('/')}
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-ink transition-colors"
    >
      <ArrowLeft size={14} /> Back to KPI Overview
    </button>
  )

  // A dispatcher can only open their own scorecard and a team leader only a
  // dispatcher on their team (typing another name into the address bar
  // doesn't get around it).
  if (scopeNames && !scopeNames.has(dispatcherName)) {
    return (
      <div className="space-y-6">
        {backButton}
        <p className="text-sm text-warn bg-warn-tint border border-warn/20 rounded-lg p-4">
          You don't have access to this dispatcher's scorecard.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {backButton}

      <PageHeader
        title={dispatcherName}
        description={`${mine.length} work orders total`}
        actions={
          kpi && (
            <div className="text-right">
              <p className="text-3xl font-extrabold text-brand-700 tabular-nums">{kpi.compositeScore.toFixed(0)}</p>
              <p className="text-xs text-ink-faint">Composite score</p>
            </div>
          )
        }
      />

      {!kpi && (
        <p className="text-sm text-warn bg-warn-tint border border-warn/20 rounded-lg p-4">
          No work orders found for this dispatcher.
        </p>
      )}

      {kpi && (
        <>
          <DispatcherStats workOrders={mine} kpi={kpi} profile={profile} />

          <div>
            <p className="text-sm font-bold text-ink mb-3">Jobs on the Map</p>
            <WorkOrdersMap workOrders={mine} height={420} />
          </div>
        </>
      )}

      <div>
        <p className="text-sm font-bold text-ink mb-3">All Work Orders</p>
        <div className="panel overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="table-head-row">
                {DETAIL_COLUMNS.map((c) => (
                  <th key={c} className="px-4 py-3 whitespace-nowrap">{columnLabel(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mine.map((w) => (
                <tr key={w.wo} className="table-row">
                  {DETAIL_COLUMNS.map((c) => (
                    <td key={c} className="px-4 py-2.5 text-ink-soft whitespace-nowrap">
                      {String(w[c] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
              {!mine.length && (
                <tr>
                  <td colSpan={DETAIL_COLUMNS.length} className="text-center text-ink-faint py-8">
                    No work orders.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
