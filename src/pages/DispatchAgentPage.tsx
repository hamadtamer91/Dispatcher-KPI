import { useState } from 'react'
import { AlertTriangle, Phone, PhoneCall, Plus, RefreshCw } from 'lucide-react'
import { useDispatchActivity } from '../hooks/useDispatchActivity'
import { useRaleyActions } from '../hooks/useRaleyActions'
import { RaleyOrderModal } from '../components/RaleyOrderModal'
import type { NewDispatchOrder } from '../lib/types'

// A status window into Raley, the separate AI dispatch agent that sources
// and negotiates with technicians by phone -- plus two actions (new work
// order, call technician now) that go through Raley's own API rather than
// reimplementing it. See README for why the two systems' schemas stay
// separate, and supabase/functions/raley-actions for how the write actions
// actually reach Raley.

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function DispatchAgentPage() {
  const { data, loading, error, refetch } = useDispatchActivity()
  const { createOrder, callTechnician, busy } = useRaleyActions()
  const [showNewOrder, setShowNewOrder] = useState(false)
  const [actionError, setActionError] = useState('')
  const [callingId, setCallingId] = useState<string | null>(null)

  const handleCreateOrder = async (payload: NewDispatchOrder) => {
    await createOrder(payload)
    await refetch()
  }

  const handleCall = async (orderTitle: string, orderId: string, techId: string, techName: string) => {
    if (!confirm(`Place a real call to ${techName} about "${orderTitle}" right now? This dials their phone immediately.`)) return
    setActionError('')
    setCallingId(techId)
    try {
      await callTechnician(orderId, techId)
      await refetch()
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setCallingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-gray-900">Dispatch Agent Activity</h2>
          <p className="text-sm text-gray-400">Raley's technician sourcing — view activity, create orders, and place calls.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewOrder(true)}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg px-3 py-2"
          >
            <Plus size={14} /> New Work Order
          </button>
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg px-3 py-2 hover:bg-gray-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {showNewOrder && <RaleyOrderModal onClose={() => setShowNewOrder(false)} onCreate={handleCreateOrder} />}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          Couldn't load dispatch agent activity: {error}
        </p>
      )}

      {actionError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          {actionError}
        </p>
      )}

      {loading && <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>}

      {!loading && data && (
        <>
          {data.alerts.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
              <p className="text-sm font-semibold text-amber-800 flex items-center gap-1.5">
                <AlertTriangle size={14} /> {data.alerts.length} unresolved alert{data.alerts.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-1">
                {data.alerts.map((a) => (
                  <li key={a.id} className="text-sm text-amber-700">
                    <span className="font-medium capitalize">{a.level}</span> — {a.message}
                    {a.order_title && <span className="text-amber-500"> ({a.order_title})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
            <h3 className="px-4 pt-4 text-sm font-bold text-gray-700">Active Orders</h3>
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-semibold">Title</th>
                  <th className="px-4 py-3 font-semibold">Trade</th>
                  <th className="px-4 py-3 font-semibold">Location</th>
                  <th className="px-4 py-3 font-semibold">Urgency</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Assigned Technician</th>
                  <th className="px-4 py-3 font-semibold">Technicians</th>
                  <th className="px-4 py-3 font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-700">{o.title}</td>
                    <td className="px-4 py-2.5 text-gray-700">{o.trade ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-700">{o.location}</td>
                    <td className="px-4 py-2.5 text-gray-700">{o.urgency ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-700">{o.status}</td>
                    <td className="px-4 py-2.5 text-gray-700">
                      {o.assigned_technician
                        ? `${o.assigned_technician.name}${o.assigned_technician.company ? ` (${o.assigned_technician.company})` : ''}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">
                      {o.technicians.length ? (
                        <ul className="space-y-1">
                          {o.technicians.map((t) => (
                            <li key={t.id} className="flex items-center gap-1.5 whitespace-nowrap">
                              <span>{t.name}{t.status ? <span className="text-gray-400"> · {t.status}</span> : null}</span>
                              <button
                                onClick={() => handleCall(o.title, o.id, t.id, t.name)}
                                disabled={busy}
                                title={`Call ${t.name} now`}
                                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <PhoneCall size={12} />
                                {callingId === t.id ? 'Calling…' : 'Call'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatWhen(o.updated_at)}</td>
                  </tr>
                ))}
                {!data.orders.length && (
                  <tr><td colSpan={8} className="text-center text-gray-400 py-8">No orders in the dispatch agent yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
            <h3 className="px-4 pt-4 text-sm font-bold text-gray-700 flex items-center gap-1.5"><Phone size={14} /> Recent Calls</h3>
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-semibold">When</th>
                  <th className="px-4 py-3 font-semibold">Order</th>
                  <th className="px-4 py-3 font-semibold">Technician</th>
                  <th className="px-4 py-3 font-semibold">Outcome</th>
                  <th className="px-4 py-3 font-semibold">Duration</th>
                  <th className="px-4 py-3 font-semibold">Summary</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatWhen(e.created_at)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{e.order_title ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-700">{e.technician_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-700">{e.ended_reason ?? e.event_type ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-700">{formatDuration(e.duration_seconds)}</td>
                    <td className="px-4 py-2.5 text-gray-600 max-w-xs truncate" title={e.summary ?? ''}>{e.summary ?? '—'}</td>
                  </tr>
                ))}
                {!data.events.length && (
                  <tr><td colSpan={6} className="text-center text-gray-400 py-8">No calls logged yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
