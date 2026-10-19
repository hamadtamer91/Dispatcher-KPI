import { Fragment, useState } from 'react'
import {
  AlertTriangle, Banknote, ChevronDown, ChevronUp, Phone, PhoneIncoming, Plus, Radio, RefreshCw, Settings2,
} from 'lucide-react'
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

function formatCurrency(n: number | null): string {
  if (n == null) return '—'
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

// Matches the original agent system's own call-direction pill (app-3.js,
// renderCallItem): "← Incoming" / "→ Outgoing", a distinct color per
// direction so it reads at a glance in a dense table.
function DirectionPill({ direction }: { direction: 'inbound' | 'outbound' | null }) {
  if (!direction) return <span className="text-ink-faint">—</span>
  return direction === 'inbound'
    ? <Badge variant="brand">← Incoming</Badge>
    : <Badge variant="neutral">→ Outgoing</Badge>
}

interface DispatchAgentPageProps {
  // When set (the dispatcher role), scopes the whole tab to just the orders
  // this dispatcher personally created, plus only the calls/alerts/inbox/
  // approvals tied to one of those orders. Omitted for the admin view, which
  // sees everything.
  dispatcherName?: string | null
}

export function DispatchAgentPage({ dispatcherName }: DispatchAgentPageProps = {}) {
  const { data, loading, error, refetch } = useDispatchActivity(dispatcherName)
  const {
    createOrder, callTechnician, updateOrder, reassignTechnician, setAutoDispatch, cancelOrder, addTechnician,
    setInboxHandled, busy,
  } = useRaleyActions()
  const [showNewOrder, setShowNewOrder] = useState(false)
  const [manageOrderId, setManageOrderId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [callingId, setCallingId] = useState<string | null>(null)
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)
  const [expandedInboxId, setExpandedInboxId] = useState<string | null>(null)
  const [inboxBusyId, setInboxBusyId] = useState<string | null>(null)

  const manageOrder = manageOrderId ? data?.orders.find((o) => o.id === manageOrderId) ?? null : null

  const handleCreateOrder = async (payload: NewDispatchOrder) => {
    await createOrder(payload, dispatcherName)
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

  const handleToggleHandled = async (inboxId: string, handled: boolean) => {
    setActionError('')
    setInboxBusyId(inboxId)
    try {
      await setInboxHandled(inboxId, handled)
      await refetch()
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setInboxBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch Agent"
        description={
          dispatcherName
            ? "Raley's technician sourcing for your orders — view activity, create orders, and place calls."
            : "Raley's technician sourcing — view activity, create orders, and place calls."
        }
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
                    {a.technician_name && <span className="opacity-70"> · {a.technician_name}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.live_calls.length > 0 && (
            <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 space-y-3">
              <p className="text-sm font-bold text-brand-700 flex items-center gap-1.5">
                <Radio size={14} className="animate-pulse" /> {data.live_calls.length} call{data.live_calls.length === 1 ? '' : 's'} live right now
                <span className="font-normal text-brand-700/70">
                  ({data.live_calls.filter((c) => c.direction === 'inbound').length} incoming, {data.live_calls.filter((c) => c.direction === 'outbound').length} outgoing)
                </span>
              </p>
              {data.live_calls.map((c) => (
                <div key={c.call_sid} className="bg-white rounded-lg border border-line p-3 space-y-1.5 max-h-48 overflow-y-auto">
                  <p className="text-xs font-semibold text-ink-faint flex items-center gap-1.5">
                    <DirectionPill direction={c.direction} /> On a call since {formatWhen(c.started_at)}
                  </p>
                  {c.lines.map((l, i) => (
                    <p key={i} className="text-sm">
                      <span className="font-semibold text-ink-soft capitalize">{l.role ?? 'Unknown'}:</span>{' '}
                      <span className="text-ink">{l.text}</span>
                    </p>
                  ))}
                  {!c.lines.length && <p className="text-sm text-ink-faint">Connecting…</p>}
                </div>
              ))}
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
                  <tr>
                    <td colSpan={9} className="text-center text-ink-faint py-8">
                      {dispatcherName ? "You haven't added any orders yet — use \"New Work Order\" above to start." : 'No orders in the dispatch agent yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel overflow-x-auto">
            <h3 className="px-4 pt-4 text-sm font-bold text-ink flex items-center gap-1.5"><PhoneIncoming size={14} /> Incoming Calls</h3>
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="table-head-row">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Caller</th>
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Summary</th>
                  <th className="px-4 py-3">Callback?</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.inbox.map((i) => (
                  <Fragment key={i.id}>
                    <tr className="table-row">
                      <td className="px-4 py-2.5 text-ink-faint whitespace-nowrap">{formatWhen(i.created_at)}</td>
                      <td className="px-4 py-2.5 text-ink">
                        {i.caller_name ?? i.technician_name ?? 'Unknown caller'}
                        {i.phone && <span className="block text-xs text-ink-faint">{i.phone}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-ink-soft">{i.order_title ?? '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{i.reason ?? '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft max-w-xs truncate" title={i.summary ?? i.message ?? ''}>
                        {i.summary ?? i.message ?? '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {i.callback_requested ? <Badge variant="warn">Requested</Badge> : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={i.handled ? 'good' : 'neutral'} dot>{i.handled ? 'Handled' : 'Open'}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2">
                          {(i.transcript || i.recording_url) && (
                            <button
                              onClick={() => setExpandedInboxId(expandedInboxId === i.id ? null : i.id)}
                              className="text-ink-faint hover:text-ink-soft"
                              title="Show transcript / recording"
                            >
                              {expandedInboxId === i.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>
                          )}
                          <button
                            onClick={() => handleToggleHandled(i.id, !i.handled)}
                            disabled={inboxBusyId === i.id}
                            className="text-xs font-semibold text-brand-700 hover:text-brand-800 disabled:opacity-50"
                          >
                            {inboxBusyId === i.id ? '...' : i.handled ? 'Reopen' : 'Mark handled'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedInboxId === i.id && (
                      <tr className="bg-canvas">
                        <td colSpan={8} className="px-4 py-3 space-y-2">
                          {i.transcript && <p className="text-xs text-ink-soft whitespace-pre-wrap">{i.transcript}</p>}
                          {i.recording_url && <audio controls src={i.recording_url} className="w-full max-w-md" />}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!data.inbox.length && (
                  <tr><td colSpan={8} className="text-center text-ink-faint py-8">No incoming calls logged yet.</td></tr>
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
                  <th className="px-4 py-3">Direction</th>
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Technician</th>
                  <th className="px-4 py-3">Outcome</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Summary</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="table-row">
                      <td className="px-4 py-2.5 text-ink-faint whitespace-nowrap">{formatWhen(e.created_at)}</td>
                      <td className="px-4 py-2.5"><DirectionPill direction={e.direction} /></td>
                      <td className="px-4 py-2.5 text-ink">{e.order_title ?? '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{e.technician_name ?? '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft">{e.ended_reason ?? e.event_type ?? '—'}</td>
                      <td className="px-4 py-2.5 text-ink-soft tabular-nums">{formatDuration(e.duration_seconds)}</td>
                      <td className="px-4 py-2.5 text-ink-soft max-w-xs truncate" title={e.summary ?? ''}>{e.summary ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {(e.transcript || e.recording_url || e.cost != null) && (
                          <button
                            onClick={() => setExpandedEventId(expandedEventId === e.id ? null : e.id)}
                            className="text-ink-faint hover:text-ink-soft"
                            title="Show transcript / recording"
                          >
                            {expandedEventId === e.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedEventId === e.id && (
                      <tr className="bg-canvas">
                        <td colSpan={8} className="px-4 py-3 space-y-2">
                          {e.cost != null && <p className="text-xs text-ink-faint">Call cost: {formatCurrency(e.cost)}</p>}
                          {e.transcript && <p className="text-xs text-ink-soft whitespace-pre-wrap">{e.transcript}</p>}
                          {e.recording_url && <audio controls src={e.recording_url} className="w-full max-w-md" />}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!data.events.length && (
                  <tr><td colSpan={8} className="text-center text-ink-faint py-8">No calls logged yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {data.approvals.length > 0 && (
            <div className="panel p-4 space-y-2">
              <h3 className="text-sm font-bold text-ink flex items-center gap-1.5"><Banknote size={14} /> Approval Requests</h3>
              <ul className="space-y-1.5">
                {data.approvals.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-sm py-1.5 border-b border-line-soft last:border-b-0">
                    <span className="text-ink-soft">
                      <span className="font-semibold text-ink capitalize">{a.kind ?? 'Request'}</span>
                      {a.order_title && <span className="text-ink-faint"> · {a.order_title}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-ink">{formatCurrency(a.requested_amount)}</span>
                      <Badge variant={a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'good' : 'neutral'}>{a.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
