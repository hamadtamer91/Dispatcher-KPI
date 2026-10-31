import { useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import { Plus, Upload, Download, Pencil, Trash2 } from 'lucide-react'
import type { WorkOrder, Role } from '../lib/types'
import { STATUS_OPTIONS } from '../lib/types'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { WorkOrderModal } from '../components/WorkOrderModal'
import { DONE_STATUSES, REASSIGNED_STATUSES } from '../lib/kpi'
import { canDeleteWorkOrders, canEditWorkOrders } from '../lib/permissions'
import { Badge, Button, PageHeader } from '../components/ui'

const COLUMNS: (keyof WorkOrder)[] = [
  'wo', 'dispatcher', 'client', 'status', 'wo_date', 'eta', 'trade', 'subtrade',
  'city', 'state', 'nte', 'cost', 'profit_pct',
]

// Display labels for columns whose field name doesn't match what should be shown
// to the user.
const COLUMN_LABELS: Partial<Record<keyof WorkOrder, string>> = {
  client: 'Client',
}

function columnLabel(c: keyof WorkOrder): string {
  return COLUMN_LABELS[c] ?? c.replace(/_/g, ' ')
}

function statusBadge(status: string | null) {
  if (!status) return <span className="text-ink-faint">—</span>
  const lower = status.toLowerCase()
  const variant = DONE_STATUSES.has(lower) ? 'good' : REASSIGNED_STATUSES.has(lower) ? 'danger' : 'neutral'
  return <Badge variant={variant}>{status}</Badge>
}

// CSV header names that should map onto the internal `client` field on import.
// 'store' is kept for backward compatibility with CSVs exported before this
// column was relabeled "Client".
const CLIENT_HEADER_ALIASES = new Set(['client', 'store'])

function toExportRow(w: WorkOrder): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(w)) {
    out[key === 'client' ? 'Client' : key] = value
  }
  return out
}

function downloadCSV(filename: string, rows: WorkOrder[]) {
  const csv = Papa.unparse(rows.map(toExportRow))
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function WorkOrdersPage({ role }: { role: Role }) {
  const { wos, loading, error, saveWO, deleteWO, importWOs } = useWorkOrders()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<WorkOrder | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canEdit = canEditWorkOrders(role)
  // Deleting is narrower than editing: an Admin can add and change work
  // orders but only a Super Admin can permanently remove one.
  const canDelete = canDeleteWorkOrders(role)

  const filtered = useMemo(() => {
    if (!search.trim()) return wos
    const q = search.toLowerCase()
    return wos.filter((w) =>
      Object.values(w).some((v) => String(v ?? '').toLowerCase().includes(q))
    )
  }, [wos, search])

  const handleImport = (file: File) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => {
        const trimmed = header.trim()
        return CLIENT_HEADER_ALIASES.has(trimmed.toLowerCase()) ? 'client' : trimmed
      },
      complete: async (results) => {
        try {
          const data = await importWOs(results.data as Partial<WorkOrder>[])
          setImportMsg(`Imported ${data?.length ?? 0} work orders.`)
        } catch (err) {
          setImportMsg(`Import failed: ${(err as Error).message}`)
        }
      },
    })
  }

  const handleDelete = async (wo: string) => {
    if (confirm(`Delete work order ${wo}? This cannot be undone.`)) {
      await deleteWO(wo)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Work Orders"
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={() => downloadCSV('work_orders.csv', filtered)}>
              Export
            </Button>
            {canEdit && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}
                />
                <Button variant="secondary" size="sm" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>
                  Import CSV
                </Button>
                <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => { setEditing(null); setShowModal(true) }}>
                  New Work Order
                </Button>
              </>
            )}
          </>
        }
      />

      <input
        type="text"
        placeholder="Search work orders..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="field w-full sm:w-72"
      />

      {importMsg && <p className="text-sm text-ink-soft">{importMsg}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="panel overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              {COLUMNS.map((c) => (
                <th key={c} className="px-4 py-3">{columnLabel(c)}</th>
              ))}
              {canEdit && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={COLUMNS.length + 1} className="text-center text-ink-faint py-8">Loading...</td></tr>
            )}
            {!loading && filtered.map((w) => (
              <tr key={w.wo} className="table-row">
                {COLUMNS.map((c) => (
                  <td key={c} className="px-4 py-2.5 text-ink whitespace-nowrap">
                    {c === 'status' ? statusBadge(w.status) : String(w[c] ?? '—')}
                  </td>
                ))}
                {canEdit && (
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => { setEditing(w); setShowModal(true) }} className="btn-icon mr-1">
                      <Pencil size={14} />
                    </button>
                    {canDelete && (
                      <button onClick={() => handleDelete(w.wo)} className="btn-icon hover:text-danger">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!loading && !filtered.length && (
              <tr><td colSpan={COLUMNS.length + 1} className="text-center text-ink-faint py-8">
                {wos.length ? 'No work orders match the current filters/search.' : 'No work orders yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <WorkOrderModal
          initial={editing}
          statusOptions={STATUS_OPTIONS}
          onClose={() => setShowModal(false)}
          onSave={async (payload) => {
            await saveWO(payload, !editing)
            setShowModal(false)
          }}
        />
      )}
    </div>
  )
}
