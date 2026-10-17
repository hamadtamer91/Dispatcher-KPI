import { useState } from 'react'
import type { WorkOrder } from '../lib/types'

interface Props {
  initial: WorkOrder | null
  statusOptions: readonly string[]
  onClose: () => void
  onSave: (payload: Partial<WorkOrder>) => Promise<void>
}

const EMPTY: Partial<WorkOrder> = {
  wo: '', dispatcher: '', client: '', status: 'New', wo_date: '', eta: '', trade: '', subtrade: '',
  address: '', city: '', state: '', nte: null, nte_approved: false, cost: null,
  profit_pct: null, description: '', quote_sent_on: '', admin_notes: '', tl_notes: '', invoiced_on: '',
  // -- Operational KPI fields (Oct 2026 expansion) --
  actual_visit_date: '', first_visit_complete: null, is_assessment_visit: null,
  assessment_fee: null, assessment_paid_on: '', reassigned_from: '', reassigned_to: '',
  reassigned_on: '', recall_of_wo: '', job_completed_on: '', closed_on: '',
  technician_name: '', technicians_count: null, tech_complaint: null, tech_complaint_notes: '',
}

export function WorkOrderModal({ initial, statusOptions, onClose, onSave }: Props) {
  const [form, setForm] = useState<Partial<WorkOrder>>(initial ?? EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isNew = !initial

  const update = (key: keyof WorkOrder, value: unknown) => setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.wo) {
      setError('Work order number is required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave(form)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">{isNew ? 'New Work Order' : `Edit Work Order ${initial?.wo}`}</h2>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Work Order #">
              <input disabled={!isNew} required value={form.wo ?? ''} onChange={(e) => update('wo', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Status">
              <select value={form.status ?? ''} onChange={(e) => update('status', e.target.value)} className={inputCls}>
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Dispatcher">
              <input value={form.dispatcher ?? ''} onChange={(e) => update('dispatcher', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Store">
              <input value={form.client ?? ''} onChange={(e) => update('client', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Trade">
              <input value={form.trade ?? ''} onChange={(e) => update('trade', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Subtrade">
              <input value={form.subtrade ?? ''} onChange={(e) => update('subtrade', e.target.value)} className={inputCls} />
            </Field>
            <Field label="WO Date">
              <input type="date" value={form.wo_date ?? ''} onChange={(e) => update('wo_date', e.target.value)} className={inputCls} />
            </Field>
            <Field label="ETA">
              <input type="date" value={form.eta ?? ''} onChange={(e) => update('eta', e.target.value)} className={inputCls} />
            </Field>
            <Field label="City">
              <input value={form.city ?? ''} onChange={(e) => update('city', e.target.value)} className={inputCls} />
            </Field>
            <Field label="State">
              <input value={form.state ?? ''} onChange={(e) => update('state', e.target.value)} className={inputCls} />
            </Field>
            <Field label="NTE ($)">
              <input type="number" step="0.01" value={form.nte ?? ''} onChange={(e) => update('nte', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Cost ($)">
              <input type="number" step="0.01" value={form.cost ?? ''} onChange={(e) => update('cost', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Profit %">
              <input type="number" step="0.01" value={form.profit_pct ?? ''} onChange={(e) => update('profit_pct', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Quote Sent On">
              <input type="date" value={form.quote_sent_on ?? ''} onChange={(e) => update('quote_sent_on', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Invoiced On">
              <input type="date" value={form.invoiced_on ?? ''} onChange={(e) => update('invoiced_on', e.target.value)} className={inputCls} />
            </Field>
            <Field label="NTE Approved">
              <select value={form.nte_approved ? 'true' : 'false'} onChange={(e) => update('nte_approved', e.target.value === 'true')} className={inputCls}>
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </Field>
          </div>

          <Field label="Address">
            <input value={form.address ?? ''} onChange={(e) => update('address', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Description">
            <textarea value={form.description ?? ''} onChange={(e) => update('description', e.target.value)} className={inputCls} rows={2} />
          </Field>
          <Field label="Admin Notes">
            <textarea value={form.admin_notes ?? ''} onChange={(e) => update('admin_notes', e.target.value)} className={inputCls} rows={2} />
          </Field>
          <Field label="TL Notes">
            <textarea value={form.tl_notes ?? ''} onChange={(e) => update('tl_notes', e.target.value)} className={inputCls} rows={2} />
          </Field>

          <div className="pt-2 border-t border-gray-100">
            <h3 className="text-sm font-bold text-gray-700 mb-3">Operational Tracking</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Actual Visit Date">
                <input type="date" value={form.actual_visit_date ?? ''} onChange={(e) => update('actual_visit_date', e.target.value)} className={inputCls} />
              </Field>
              <Field label="First Visit Complete">
                <TriStateSelect value={form.first_visit_complete} onChange={(v) => update('first_visit_complete', v)} />
              </Field>
              <Field label="Technician Name">
                <input value={form.technician_name ?? ''} onChange={(e) => update('technician_name', e.target.value)} className={inputCls} />
              </Field>
              <Field label="# Technicians Sent">
                <input type="number" step="1" value={form.technicians_count ?? ''} onChange={(e) => update('technicians_count', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Is Assessment Visit">
                <TriStateSelect value={form.is_assessment_visit} onChange={(v) => update('is_assessment_visit', v)} />
              </Field>
              <Field label="Assessment Fee ($)">
                <input type="number" step="0.01" value={form.assessment_fee ?? ''} onChange={(e) => update('assessment_fee', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Assessment Paid On">
                <input type="date" value={form.assessment_paid_on ?? ''} onChange={(e) => update('assessment_paid_on', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Recall Of WO #">
                <input value={form.recall_of_wo ?? ''} onChange={(e) => update('recall_of_wo', e.target.value)} className={inputCls} placeholder="WO # this is a recall of" />
              </Field>
              <Field label="Reassigned From">
                <input value={form.reassigned_from ?? ''} onChange={(e) => update('reassigned_from', e.target.value)} className={inputCls} placeholder="Dispatcher name" />
              </Field>
              <Field label="Reassigned To">
                <input value={form.reassigned_to ?? ''} onChange={(e) => update('reassigned_to', e.target.value)} className={inputCls} placeholder="Dispatcher name" />
              </Field>
              <Field label="Reassigned On">
                <input type="date" value={form.reassigned_on ?? ''} onChange={(e) => update('reassigned_on', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Job Completed On">
                <input type="date" value={form.job_completed_on ?? ''} onChange={(e) => update('job_completed_on', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Closed On">
                <input type="date" value={form.closed_on ?? ''} onChange={(e) => update('closed_on', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Tech Complaint">
                <TriStateSelect value={form.tech_complaint} onChange={(v) => update('tech_complaint', v)} />
              </Field>
            </div>
            <div className="mt-4">
              <Field label="Tech Complaint Notes">
                <textarea value={form.tech_complaint_notes ?? ''} onChange={(e) => update('tech_complaint_notes', e.target.value)} className={inputCls} rows={2} />
              </Field>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-60">
              {saving ? 'Saving...' : 'Save'}
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

/** A Yes/No/Unknown select for nullable boolean fields that haven't been recorded yet. */
function TriStateSelect({ value, onChange }: { value: boolean | null | undefined; onChange: (v: boolean | null) => void }) {
  const str = value === true ? 'true' : value === false ? 'false' : ''
  return (
    <select
      value={str}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
      className={inputCls}
    >
      <option value="">Unknown</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  )
}
