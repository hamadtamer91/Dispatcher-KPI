import { useState } from 'react'
import { PhoneCall, UserPlus } from 'lucide-react'
import type { DispatchOrderPatch, DispatchOrderSummary, NewDispatchTechnician } from '../lib/types'

interface Props {
  order: DispatchOrderSummary
  onClose: () => void
  onSave: (orderId: string, patch: DispatchOrderPatch) => Promise<void>
  onReassign: (orderId: string, technicianId: string | null) => Promise<void>
  onToggleAutoDispatch: (orderId: string, autoDispatch: boolean) => Promise<void>
  onCancelOrder: (orderId: string) => Promise<void>
  onAddTechnician: (orderId: string, technician: NewDispatchTechnician) => Promise<void>
  onCall: (orderTitle: string, orderId: string, techId: string, techName: string) => Promise<void>
  busy: boolean
  callingId: string | null
}

const EMPTY_TECH: NewDispatchTechnician = { name: '', company: '', phone: '', email: '' }

export function RaleyManageOrderModal({
  order, onClose, onSave, onReassign, onToggleAutoDispatch, onCancelOrder, onAddTechnician, onCall, busy, callingId,
}: Props) {
  const [form, setForm] = useState<DispatchOrderPatch>({
    title: order.title,
    trade: order.trade ?? '',
    location: order.location,
    description: order.description ?? '',
    urgency: (order.urgency as DispatchOrderPatch['urgency']) ?? 'Routine',
    repair_ceiling: order.repair_ceiling ?? 0,
    assessment_target: order.assessment_target,
    ground_rules: order.ground_rules ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showAddTech, setShowAddTech] = useState(false)
  const [newTech, setNewTech] = useState<NewDispatchTechnician>(EMPTY_TECH)
  const [addingTech, setAddingTech] = useState(false)
  const isCancelled = order.status === 'Cancelled'

  const update = <K extends keyof DispatchOrderPatch>(key: K, value: DispatchOrderPatch[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const runAction = async (action: () => Promise<void>, successMsg?: string) => {
    setError('')
    setNotice('')
    try {
      await action()
      if (successMsg) setNotice(successMsg)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title || !form.location) {
      setError('Title and location are required.')
      return
    }
    if (!form.repair_ceiling || form.repair_ceiling <= 0) {
      setError("Repair ceiling is required -- it's Raley's hard limit on any price it agrees to.")
      return
    }
    setSaving(true)
    await runAction(() => onSave(order.id, form), 'Saved.')
    setSaving(false)
  }

  const handleReassign = async (technicianId: string) => {
    await runAction(
      () => onReassign(order.id, technicianId || null),
      technicianId ? 'Reassigned.' : 'Assignment cleared.',
    )
  }

  const handleToggleAutoDispatch = async () => {
    await runAction(
      () => onToggleAutoDispatch(order.id, !order.auto_dispatch),
      order.auto_dispatch ? 'Auto-dispatch paused.' : 'Auto-dispatch resumed.',
    )
  }

  const handleCancelOrder = async () => {
    if (!confirm(`Cancel "${order.title}"? Raley will stop working this order -- it won't call any more technicians about it.`)) return
    await runAction(() => onCancelOrder(order.id), 'Order cancelled.')
  }

  const handleAddTechnician = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTech.name.trim()) {
      setError('Technician name is required.')
      return
    }
    setAddingTech(true)
    await runAction(() => onAddTechnician(order.id, newTech), `${newTech.name} added as a candidate.`)
    setAddingTech(false)
    setNewTech(EMPTY_TECH)
    setShowAddTech(false)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">{order.title}</h2>
              <p className="text-sm text-gray-400 mt-0.5">
                Status: <span className="font-medium text-gray-600">{order.status}</span>
              </p>
            </div>
            <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-600">Close</button>
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">{error}</p>}
          {notice && !error && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">{notice}</p>}

          {/* Auto-dispatch + cancel */}
          <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg p-3">
            <div>
              <p className="text-sm font-semibold text-gray-700">Auto-dispatch</p>
              <p className="text-xs text-gray-400">Lets Raley keep calling technicians on its own. Checked every ~5 min.</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={!!order.auto_dispatch}
                  disabled={busy || isCancelled}
                  onChange={handleToggleAutoDispatch}
                />
                <div className="w-10 h-5.5 bg-gray-300 peer-checked:bg-indigo-600 rounded-full peer-disabled:opacity-50 transition-colors relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4.5 after:w-4.5 after:transition-all peer-checked:after:translate-x-4.5" />
              </label>
              {!isCancelled && (
                <button
                  onClick={handleCancelOrder}
                  disabled={busy}
                  className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  Cancel order
                </button>
              )}
            </div>
          </div>

          {/* Reassign technician */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
            <p className="text-sm font-semibold text-gray-700">Assigned technician</p>
            <select
              value={order.assigned_technician_id ?? ''}
              disabled={busy || isCancelled}
              onChange={(e) => handleReassign(e.target.value)}
              className={inputCls}
            >
              <option value="">— None —</option>
              {order.technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.company ? ` (${t.company})` : ''}{t.status ? ` — ${t.status}` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400">Changing this updates the record but doesn't notify the technician -- use "Call" below for that.</p>

            {order.technicians.length > 0 && (
              <ul className="space-y-1 pt-1">
                {order.technicians.map((t) => (
                  <li key={t.id} className="flex items-center justify-between text-sm py-1 border-t border-gray-200 first:border-t-0 first:pt-0">
                    <span className="text-gray-700">
                      {t.name}{t.company ? <span className="text-gray-400"> · {t.company}</span> : null}
                      {t.status ? <span className="text-gray-400"> · {t.status}</span> : null}
                    </span>
                    <button
                      onClick={() => onCall(order.title, order.id, t.id, t.name)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <PhoneCall size={12} />
                      {callingId === t.id ? 'Calling…' : 'Call'}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!isCancelled && (
              <>
                {!showAddTech ? (
                  <button
                    type="button"
                    onClick={() => setShowAddTech(true)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 pt-1"
                  >
                    <UserPlus size={12} /> Add a technician
                  </button>
                ) : (
                  <form onSubmit={handleAddTechnician} className="pt-2 space-y-2 border-t border-gray-200">
                    <p className="text-xs font-semibold text-gray-600 pt-1">New technician</p>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        placeholder="Name *"
                        value={newTech.name}
                        onChange={(e) => setNewTech((t) => ({ ...t, name: e.target.value }))}
                        className={inputCls}
                      />
                      <input
                        placeholder="Company"
                        value={newTech.company}
                        onChange={(e) => setNewTech((t) => ({ ...t, company: e.target.value }))}
                        className={inputCls}
                      />
                      <input
                        placeholder="Phone"
                        value={newTech.phone}
                        onChange={(e) => setNewTech((t) => ({ ...t, phone: e.target.value }))}
                        className={inputCls}
                      />
                      <input
                        placeholder="Email"
                        value={newTech.email}
                        onChange={(e) => setNewTech((t) => ({ ...t, email: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => { setShowAddTech(false); setNewTech(EMPTY_TECH) }}
                        className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={addingTech || busy}
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-60"
                      >
                        {addingTech ? 'Adding...' : 'Add technician'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>

          {/* Edit order details */}
          <form onSubmit={handleSave} className="space-y-4">
            <p className="text-sm font-semibold text-gray-700">Order details</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Title *">
                <input required value={form.title ?? ''} onChange={(e) => update('title', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Location *">
                <input required value={form.location ?? ''} onChange={(e) => update('location', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Trade">
                <input value={form.trade ?? ''} onChange={(e) => update('trade', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Urgency">
                <select value={form.urgency} onChange={(e) => update('urgency', e.target.value as DispatchOrderPatch['urgency'])} className={inputCls}>
                  <option value="Routine">Routine</option>
                  <option value="Priority">Priority</option>
                  <option value="Emergency">Emergency</option>
                </select>
              </Field>
              <Field label="Repair Ceiling ($) *">
                <input required type="number" min="0" step="0.01" value={form.repair_ceiling || ''} onChange={(e) => update('repair_ceiling', Number(e.target.value))} className={inputCls} />
              </Field>
              <Field label="Target Assessment Fee ($)">
                <input type="number" min="0" step="0.01" value={form.assessment_target ?? ''} onChange={(e) => update('assessment_target', e.target.value === '' ? null : Number(e.target.value))} className={inputCls} />
              </Field>
            </div>
            <Field label="Description">
              <textarea value={form.description ?? ''} onChange={(e) => update('description', e.target.value)} className={inputCls} rows={2} />
            </Field>
            <Field label="Ground Rules">
              <textarea value={form.ground_rules ?? ''} onChange={(e) => update('ground_rules', e.target.value)} className={inputCls} rows={2} />
            </Field>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg">Done</button>
              <button type="submit" disabled={saving || busy} className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-60">
                {saving ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}
