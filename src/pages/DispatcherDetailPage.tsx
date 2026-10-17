import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useProfiles } from '../hooks/useProfiles'
import { computeDispatcherKPIs } from '../lib/kpi'
import type { WorkOrder } from '../lib/types'
import { DispatcherStats } from '../components/DispatcherStats'
import { WorkOrdersMap } from '../components/WorkOrdersMap'

const DETAIL_COLUMNS: (keyof WorkOrder)[] = [
  'wo', 'status', 'client', 'wo_date', 'eta', 'trade', 'subtrade',
  'city', 'state', 'nte', 'nte_approved', 'cost', 'profit_pct',
  'quote_sent_on', 'invoiced_on',
]

// 'client' is stored as-is in the database, but the sheet/UI calls this a "Store".
const COLUMN_LABELS: Partial<Record<keyof WorkOrder, string>> = {
  client: 'Store',
}

function columnLabel(c: keyof WorkOrder): string {
  return COLUMN_LABELS[c] ?? c.replace(/_/g, ' ')
}

export function DispatcherDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const dispatcherName = decodeURIComponent(name ?? '')
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

  if (woLoading || pLoading) {
    return <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('/')}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft size={14} /> Back to KPI Overview
      </button>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{dispatcherName}</h2>
          <p className="text-sm text-gray-400">{mine.length} work orders total</p>
        </div>
        {kpi && (
          <div className="text-right">
            <p className="text-3xl font-bold text-indigo-600">{kpi.compositeScore.toFixed(0)}</p>
            <p className="text-xs text-gray-400">Composite score</p>
          </div>
        )}
      </div>

      {!kpi && (
        <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-4">
          No work orders found for this dispatcher.
        </p>
      )}

      {kpi && (
        <>
          <DispatcherStats workOrders={mine} kpi={kpi} profile={profile} />

          <div>
            <p className="text-sm font-semibold text-gray-700 mb-3">Jobs on the Map</p>
            <WorkOrdersMap workOrders={mine} height={420} />
          </div>
        </>
      )}

      <div>
        <p className="text-sm font-semibold text-gray-700 mb-3">All Work Orders</p>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                {DETAIL_COLUMNS.map((c) => (
                  <th key={c} className="px-4 py-3 font-semibold whitespace-nowrap">{columnLabel(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mine.map((w) => (
                <tr key={w.wo} className="border-b border-gray-100 hover:bg-gray-50">
                  {DETAIL_COLUMNS.map((c) => (
                    <td key={c} className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {String(w[c] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
              {!mine.length && (
                <tr>
                  <td colSpan={DETAIL_COLUMNS.length} className="text-center text-gray-400 py-8">
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
