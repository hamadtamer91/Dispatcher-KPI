import { useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import { Plus, Upload, Download, Pencil, Trash2 } from 'lucide-react'
import type { WorkOrder, Role } from '../lib/types'
import { STATUS_OPTIONS } from '../lib/types'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { WorkOrderModal } from '../components/WorkOrderModal'

const COLUMNS: (keyof WorkOrder)[] = [
  'wo', 'dispatcher', 'client', 'status', 'wo_date', 'eta', 'trade', 'subtrade',
  'city', 'state', 'nte', 'cost', 'profit_pct',
]

// Display labels for columns whose field name doesn't match what should be shown
// to the user. 'client' is stored as-is in the database, but the sheet/UI calls
// this a "Store" (the physical client location a work order was opened for).
const COLUMN_LABELS: Partial<Record<keyof WorkOrder, string>> = {
  client: 'Store',
}

function columnLabel(c: keyof WorkOrder): string {
  return COLUMN_LABELS[c] ?? c.replace(/_/g, ' ')
}

// CSV header names that should map onto the internal `client` field on import,
// so a sheet using "Store" as its column header still populates correctly.
const CLIENT_HEADER_ALIASES = new Set(['client', 'store'])

function toExportRow(w: WorkOrder): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(w)) {
    out[key === 'client' ? 'Store' : key] = value
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
  const canEdit = role === 'super_admin' || role === 'data_entry'

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          placeholder="Search work orders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="flex gap-2">
          <button
            onClick={() => downloadCSV('work_orders.csv', filtered)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg px-3 py-2 hover:bg-gray-50"
          >
            <Download size={14} /> Export
          </button>
          {canEdit && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg px-3 py-2 hover:bg-gray-50"
              >
                <Upload size={14} /> Import CSV
              </button>
              <button
                onClick={() => { setEditing(null); setShowModal(true) }}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg px-3 py-2 hover:bg-indigo-700"
              >
                <Plus size={14} /> New Work Order
              </button>
            </>
          )}
        </div>
      </div>

      {importMsg && <p className="text-sm text-gray-500">{importMsg}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              {COLUMNS.map((c) => (
                <th key={c} className="px-4 py-3 font-semibold">{columnLabel(c)}</th>
              ))}
              {canEdit && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={COLUMNS.length + 1} className="text-center text-gray-400 py-8">Loading...</td></tr>
            )}
            {!loading && filtered.map((w) => (
              <tr key={w.wo} className="border-b border-gray-100 hover:bg-gray-50">
                {COLUMNS.map((c) => (
                  <td key={c} className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{String(w[c] ?? '—')}</td>
                ))}
                {canEdit && (
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => { setEditing(w); setShowModal(true) }} className="text-gray-400 hover:text-indigo-600 mr-2">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(w.wo)} className="text-gray-400 hover:text-red-600">
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!loading && !filtered.length && (
              <tr><td colSpan={COLUMNS.length + 1} className="text-center text-gray-400 py-8">
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
