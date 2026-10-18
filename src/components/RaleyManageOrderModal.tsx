import { useState } from 'react'
import { PhoneCall, UserPlus } from 'lucide-react'
import { Badge, Button } from './ui'
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
    <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-line w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-ink">{order.title}</h2>
              <p className="text-sm text-ink-faint mt-0.5 flex items-center gap-2">
                Status: <Badge variant={isCancelled ? 'danger' : 'neutral'}>{order.status}</Badge>
              </p>
            </div>
            <button onClick={onClose} className="text-sm font-semibold text-ink-faint hover:text-ink-soft">Close</button>
          </div>

          {error && <p className="text-sm text-danger bg-danger-tint border border-danger/20 rounded-lg p-2.5">{error}</p>}
          {notice && !error && <p className="text-sm text-good bg-good-tint border border-good/20 rounded-lg p-2.5">{notice}</p>}

          {/* Auto-dispatch + cancel */}
          <div className="flex items-center justify-between bg-canvas border border-line rounded-lg p-3">
            <div>
              <p className="text-sm font-bold text-ink">Auto-dispatch</p>
              <p className="text-xs text-ink-faint">Lets Raley keep calling technicians on its own. Checked every ~5 min.</p>
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
                <div className="w-10 h-5.5 bg-line peer-checked:bg-brand-600 rounded-full peer-disabled:opacity-50 transition-colors relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4.5 after:w-4.5 after:transition-all peer-checked:after:translate-x-4.5" />
              </label>
              {!isCancelled && (
                <button
                  onClick={handleCancelOrder}
                  disabled={busy}
                  className="text-xs font-semibold text-danger hover:text-danger/80 disabled:opacity-50"
                >
                  Cancel order
                </button>
              )}
            </div>
          </div>

          {/* Reassign technician */}
          <div className="bg-canvas border border-line rounded-lg p-3 space-y-2">
            <p className="text-sm font-bold text-ink">Assigned technician</p>
            <select
              value={order.assigned_technician_id ?? ''}
              disabled={busy || isCancelled}
              onChange={(e) => handleReassign(e.target.value)}
              className="field"
            >
              <option value="">— None —</option>
              {order.technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.company ? ` (${t.company})` : ''}{t.status ? ` — ${t.status}` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-faint">Changing this updates the record but doesn't notify the technician -- use "Call" below for that.</p>

            {order.technicians.length > 0 && (
              <ul className="space-y-1 pt-1">
                {order.technicians.map((t) => (
                  <li key={t.id} className="flex items-center justify-between text-sm py-1 border-t border-line first:border-t-0 first:pt-0">
                    <span className="text-ink-soft">
                      {t.name}{t.company ? <span className="text-ink-faint"> · {t.company}</span> : null}
                      {t.status ? <span className="text-ink-faint"> · {t.status}</span> : null}
                    </span>
                    <button
                      onClick={() => onCall(order.title, order.id, t.id, t.name)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800 pt-1"
                  >
                    <UserPlus size={12} /> Add a technician
                  </button>
                ) : (
                  <form onSubmit={handleAddTechnician} className="pt-2 space-y-2 border-t border-line">
                    <p className="text-xs font-bold text-ink-soft pt-1">New technician</p>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        placeholder="Name *"
                        value={newTech.name}
                        onChange={(e) => setNewTech((t) => ({ ...t, name: e.target.value }))}
                        className="field"
                      />
                      <input
                        placeholder="Company"
                        value={newTech.company}
                        onChange={(e) => setNewTech((t) => ({ ...t, company: e.target.value }))}
                        className="field"
                      />
                      <input
                        placeholder="Phone"
                        value={newTech.phone}
                        onChange={(e) => setNewTech((t) => ({ ...t, phone: e.target.value }))}
                        className="field"
                      />
                      <input
                        placeholder="Email"
                        value={newTech.email}
                        onChange={(e) => setNewTech((t) => ({ ...t, email: e.target.value }))}
                        className="field"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddTech(false); setNewTech(EMPTY_TECH) }}>
                        Cancel
                      </Button>
                      <Button type="submit" variant="primary" size="sm" disabled={addingTech || busy}>
                        {addingTech ? 'Adding...' : 'Add technician'}
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>

          {/* Edit order details */}
          <form onSubmit={handleSave} className="space-y-4">
            <p className="text-sm font-bold text-ink">Order details</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Title *">
                <input required value={form.title ?? ''} onChange={(e) => update('title', e.target.value)} className="field" />
              </Field>
              <Field label="Location *">
                <input required value={form.location ?? ''} onChange={(e) => update('location', e.target.value)} className="field" />
              </Field>
              <Field label="Trade">
                <input value={form.trade ?? ''} onChange={(e) => update('trade', e.target.value)} className="field" />
              </Field>
              <Field label="Urgency">
                <select value={form.urgency} onChange={(e) => update('urgency', e.target.value as DispatchOrderPatch['urgency'])} className="field">
                  <option value="Routine">Routine</option>
                  <option value="Priority">Priority</option>
                  <option value="Emergency">Emergency</option>
                </select>
              </Field>
              <Field label="Repair Ceiling ($) *">
                <input required type="number" min="0" step="0.01" value={form.repair_ceiling || ''} onChange={(e) => update('repair_ceiling', Number(e.target.value))} className="field" />
              </Field>
              <Field label="Target Assessment Fee ($)">
                <input type="number" min="0" step="0.01" value={form.assessment_target ?? ''} onChange={(e) => update('assessment_target', e.target.value === '' ? null : Number(e.target.value))} className="field" />
              </Field>
            </div>
            <Field label="Description">
              <textarea value={form.description ?? ''} onChange={(e) => update('description', e.target.value)} className="field" rows={2} />
            </Field>
            <Field label="Ground Rules">
              <textarea value={form.ground_rules ?? ''} onChange={(e) => update('ground_rules', e.target.value)} className="field" rows={2} />
            </Field>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
              <Button type="submit" variant="primary" disabled={saving || busy}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  )
}
