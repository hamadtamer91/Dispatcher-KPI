import { useState } from 'react'
import type { NewDispatchOrder } from '../lib/types'

interface Props {
  onClose: () => void
  onCreate: (payload: NewDispatchOrder) => Promise<void>
}

const EMPTY: NewDispatchOrder = {
  title: '', location: '', trade: '', description: '', urgency: 'Routine',
  repair_ceiling: 0, assessment_target: null, ground_rules: '', auto_dispatch: false,
}

export function RaleyOrderModal({ onClose, onCreate }: Props) {
  const [form, setForm] = useState<NewDispatchOrder>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const update = <K extends keyof NewDispatchOrder>(key: K, value: NewDispatchOrder[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title || !form.location) {
      setError('Title and location are required.')
      return
    }
    if (!form.repair_ceiling || form.repair_ceiling <= 0) {
      setError("Repair ceiling is required -- it's Raley's hard limit on any price it agrees to.")
      return
    }
    if (form.assessment_target != null && form.assessment_target > form.repair_ceiling) {
      setError("Target assessment fee can't be higher than the repair ceiling.")
      return
    }
    setSaving(true)
    setError('')
    try {
      await onCreate(form)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">New Work Order for Raley</h2>
            <p className="text-sm text-gray-400 mt-0.5">This creates a real order in Raley's system. If auto-dispatch is on, it starts calling technicians.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Title *">
              <input required value={form.title} onChange={(e) => update('title', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Location *">
              <input required value={form.location} onChange={(e) => update('location', e.target.value)} className={inputCls} placeholder="Address or site name" />
            </Field>
            <Field label="Trade">
              <input value={form.trade ?? ''} onChange={(e) => update('trade', e.target.value)} className={inputCls} placeholder="Plumbing, HVAC, …" />
            </Field>
            <Field label="Urgency">
              <select value={form.urgency} onChange={(e) => update('urgency', e.target.value as NewDispatchOrder['urgency'])} className={inputCls}>
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
            <textarea value={form.ground_rules ?? ''} onChange={(e) => update('ground_rules', e.target.value)} className={inputCls} rows={2} placeholder="Anything Raley should know before negotiating" />
          </Field>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={!!form.auto_dispatch} onChange={(e) => update('auto_dispatch', e.target.checked)} />
            Let Raley auto-dispatch (start calling technicians on its own)
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-60">
              {saving ? 'Creating...' : 'Create Order'}
            </button>
          </div>
        </form>
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
