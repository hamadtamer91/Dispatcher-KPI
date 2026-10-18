import { useState } from 'react'
import { AlertTriangle, Phone, Plus, RefreshCw, Settings2 } from 'lucide-react'
import { useDispatchActivity } from '../hooks/useDispatchActivity'
import { useRaleyActions } from '../hooks/useRaleyActions'
import { RaleyOrderModal } from '../components/RaleyOrderModal'
import { RaleyManageOrderModal } from '../components/RaleyManageOrderModal'
import type { NewDispatchOrder } from '../lib/types'
import { Badge, Button, PageHeader } from '../components/ui'

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
  const { createOrder, callTechnician, updateOrder, reassignTechnician, setAutoDispatch, cancelOrder, addTechnician, busy } = useRaleyActions()
  const [showNewOrder, setShowNewOrder] = useState(false)
  const [manageOrderId, setManageOrderId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [callingId, setCallingId] = useState<string | null>(null)

  const manageOrder = manageOrderId ? data?.orders.find((o) => o.id === manageOrderId) ?? null : null

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

  const handleSaveOrder: React.ComponentProps<typeof RaleyManageOrderModal>['onSave'] = async (orderId, patch) => {
    await updateOrder(orderId, patch)
    await refetch()
  }

  const handleReassign: React.ComponentProps<typeof RaleyManageOrderModal>['onReassign'] = async (orderId, technicianId) => {
    await reassignTechnician(orderId, technicianId)
    await refetch()
  }

  const handleToggleAutoDispatch: React.ComponentProps<typeof RaleyManageOrderModal>['onToggleAutoDispatch'] = async (orderId, autoDispatch) => {
    await setAutoDispatch(orderId, autoDispatch)
    await refetch()
  }

  const handleCancelOrder: React.ComponentProps<typeof RaleyManageOrderModal>['onCancelOrder'] = async (orderId) => {
    await cancelOrder(orderId)
    await refetch()
  }

  const handleAddTechnician: React.ComponentProps<typeof RaleyManageOrderModal>['onAddTechnician'] = async (orderId, technician) => {
    await addTechnician(orderId, technician)
    await refetch()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch Agent"
        description="Raley's technician sourcing — view activity, create orders, and place calls."
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => refetch()}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowNewOrder(true)}>
              New Work Order
            </Button>
          </>
        }
      />

      {showNewOrder && <RaleyOrderModal onClose={() => setShowNewOrder(false)} onCreate={handleCreateOrder} />}

      {manageOrder && (
        <RaleyManageOrderModal
          order={manageOrder}
          onClose={() => setManageOrderId(null)}
          onSave={handleSaveOrder}
          onReassign={handleReassign}
          onToggleAutoDispatch={handleToggleAutoDispatch}
          onCancelOrder={handleCancelOrder}
          onAddTechnician={handleAddTechnician}
          onCall={handleCall}
          busy={busy}
          callingId={callingId}
        />
      )}

      {error && (
        <p className="text-sm text-danger bg-danger-tint border border-danger/20 rounded-lg p-3">
          Couldn't load dispatch agent activity: {error}
        </p>
      )}

      {actionError && (
        <p className="text-sm text-danger bg-danger-tint border border-danger/20 rounded-lg p-3">
          {actionError}
        </p>
      )}

      {loading && <p className="text-sm text-ink-faint py-8 text-center">Loading...</p>}

      {!loading && data && (
        <>
          {data.alerts.length > 0 && (
            <div className="bg-warn-tint border border-warn/20 rounded-xl p-4 space-y-2">
              <p className="text-sm font-bold text-warn flex items-center gap-1.5">
                <AlertTriangle size={14} /> {data.alerts.length} unresolved alert{data.alerts.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-1">
                {data.alerts.map((a) => (
                  <li key={a.id} className="text-sm text-warn">
                    <span className="font-semibold capitalize">{a.level}</span> — {a.message}
                    {a.order_title && <span className="opacity-70"> ({a.order_title})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="panel overflow-x-auto">
            <h3 className="px-4 pt-4 text-sm font-bold text-ink">Active Orders</h3>
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="table-head-row">
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Trade</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Urgency</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Assigned Technician</th>
                  <th className="px-4 py-3">Auto-Dispatch</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="table-row">
                    <td className="px-4 py-2.5 text-ink font-medium">{o.title}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{o.trade ?? '—'}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{o.location}</td>
                    <td className="px-4 py-2.5">{urgencyBadge(o.urgency)}</td>
                    <td className="px-4 py-2.5">{orderStatusBadge(o.status)}</td>
                    <td className="px-4 py-2.5 text-ink-soft">
                      {o.assigned_technician
                        ? `${o.assigned_technician.name}${o.assigned_technician.company ? ` (${o.assigned_technician.company})` : ''}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={o.auto_dispatch ? 'brand' : 'neutral'} dot>{o.auto_dispatch ? 'On' : 'Off'}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-ink-faint whitespace-nowrap">{formatWhen(o.updated_at)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => setManageOrderId(o.id)}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800"
                      >
                        <Settings2 size={12} /> Manage
                      </button>
                    </td>
                  </tr>
                ))}
                {!data.orders.length && (
                  <tr><td colSpan={9} className="text-center text-ink-faint py-8">No orders in the dispatch agent yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel overflow-x-auto">
            <h3 className="px-4 pt-4 text-sm font-bold text-ink flex items-center gap-1.5"><Phone size={14} /> Recent Calls</h3>
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="table-head-row">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Technician</th>
                  <th className="px-4 py-3">Outcome</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Summary</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id} className="table-row">
                    <td className="px-4 py-2.5 text-ink-faint whitespace-nowrap">{formatWhen(e.created_at)}</td>
                    <td className="px-4 py-2.5 text-ink">{e.order_title ?? '—'}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{e.technician_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{e.ended_reason ?? e.event_type ?? '—'}</td>
                    <td className="px-4 py-2.5 text-ink-soft tabular-nums">{formatDuration(e.duration_seconds)}</td>
                    <td className="px-4 py-2.5 text-ink-soft max-w-xs truncate" title={e.summary ?? ''}>{e.summary ?? '—'}</td>
                  </tr>
                ))}
                {!data.events.length && (
                  <tr><td colSpan={6} className="text-center text-ink-faint py-8">No calls logged yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function urgencyBadge(urgency: string | null) {
  if (!urgency) return <span className="text-ink-faint">—</span>
  const variant = urgency === 'Emergency' ? 'danger' : urgency === 'Priority' ? 'warn' : 'neutral'
  return <Badge variant={variant}>{urgency}</Badge>
}

function orderStatusBadge(status: string) {
  const lower = status.toLowerCase()
  const variant = lower === 'cancelled' ? 'danger' : lower === 'job confirmed' ? 'good' : lower === 'dispatched' ? 'brand' : 'neutral'
  return <Badge variant={variant}>{status}</Badge>
}
