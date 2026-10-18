import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { usePriceLists } from '../hooks/usePriceLists'
import { Button, PageHeader } from '../components/ui'

export function PriceListsPage() {
  const { laborRates, parts, loading, error, saveLaborRate, deleteLaborRate, savePart, deletePart } = usePriceLists()
  const [newRole, setNewRole] = useState('')
  const [newRoleCost, setNewRoleCost] = useState('')
  const [newPartName, setNewPartName] = useState('')
  const [newPartCost, setNewPartCost] = useState('')
  const [newPartSku, setNewPartSku] = useState('')
  const [newPartUnit, setNewPartUnit] = useState('ea')

  if (loading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading price lists...</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Price Lists"
        description="Used to price proposal line items. Markup is set per-proposal; these are cost-side rates."
      />
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="panel p-5 space-y-3">
        <h3 className="text-sm font-bold text-ink">Labor Rates</h3>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              <th className="py-2">Role</th>
              <th className="py-2">Hourly Cost</th>
              <th className="py-2">Active</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {laborRates.map((r) => (
              <tr key={r.id} className="table-row">
                <td className="py-2 pr-3">
                  <input
                    defaultValue={r.role_name}
                    onBlur={(e) => e.target.value !== r.role_name && saveLaborRate({ id: r.id, role_name: e.target.value })}
                    className="field-inline"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    defaultValue={r.hourly_cost}
                    onBlur={(e) => saveLaborRate({ id: r.id, hourly_cost: Number(e.target.value) || 0 })}
                    className="field-inline w-24"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    defaultChecked={r.active}
                    onChange={(e) => saveLaborRate({ id: r.id, active: e.target.checked })}
                  />
                </td>
                <td className="py-2 text-right">
                  <button onClick={() => deleteLaborRate(r.id)} className="btn-icon hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {!laborRates.length && (
              <tr>
                <td colSpan={4} className="text-center text-ink-faint py-4">No labor roles yet.</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="flex items-end gap-2 pt-2 flex-wrap">
          <input placeholder="Role name" value={newRole} onChange={(e) => setNewRole(e.target.value)} className="field w-48" />
          <input placeholder="Hourly cost" type="number" value={newRoleCost} onChange={(e) => setNewRoleCost(e.target.value)} className="field w-32" />
          <Button
            variant="secondary"
            icon={<Plus size={14} />}
            onClick={async () => {
              if (!newRole.trim()) return
              await saveLaborRate({ role_name: newRole.trim(), hourly_cost: Number(newRoleCost) || 0 })
              setNewRole('')
              setNewRoleCost('')
            }}
          >
            Add Role
          </Button>
        </div>
      </div>

      <div className="panel p-5 space-y-3">
        <h3 className="text-sm font-bold text-ink">Parts Catalog</h3>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              <th className="py-2">Name</th>
              <th className="py-2">SKU</th>
              <th className="py-2">Unit Cost</th>
              <th className="py-2">Unit</th>
              <th className="py-2">Active</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.id} className="table-row">
                <td className="py-2 pr-3">
                  <input
                    defaultValue={p.name}
                    onBlur={(e) => e.target.value !== p.name && savePart({ id: p.id, name: e.target.value })}
                    className="field-inline"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    defaultValue={p.sku ?? ''}
                    onBlur={(e) => savePart({ id: p.id, sku: e.target.value || null })}
                    className="field-inline w-24"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    defaultValue={p.unit_cost}
                    onBlur={(e) => savePart({ id: p.id, unit_cost: Number(e.target.value) || 0 })}
                    className="field-inline w-24"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    defaultValue={p.unit}
                    onBlur={(e) => savePart({ id: p.id, unit: e.target.value || 'ea' })}
                    className="field-inline w-16"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    defaultChecked={p.active}
                    onChange={(e) => savePart({ id: p.id, active: e.target.checked })}
                  />
                </td>
                <td className="py-2 text-right">
                  <button onClick={() => deletePart(p.id)} className="btn-icon hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {!parts.length && (
              <tr>
                <td colSpan={6} className="text-center text-ink-faint py-4">No parts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="flex items-end gap-2 pt-2 flex-wrap">
          <input placeholder="Part name" value={newPartName} onChange={(e) => setNewPartName(e.target.value)} className="field w-48" />
          <input placeholder="SKU (optional)" value={newPartSku} onChange={(e) => setNewPartSku(e.target.value)} className="field w-32" />
          <input placeholder="Unit cost" type="number" value={newPartCost} onChange={(e) => setNewPartCost(e.target.value)} className="field w-28" />
          <input placeholder="Unit" value={newPartUnit} onChange={(e) => setNewPartUnit(e.target.value)} className="field w-20" />
          <Button
            variant="secondary"
            icon={<Plus size={14} />}
            onClick={async () => {
              if (!newPartName.trim()) return
              await savePart({
                name: newPartName.trim(),
                sku: newPartSku.trim() || null,
                unit_cost: Number(newPartCost) || 0,
                unit: newPartUnit.trim() || 'ea',
              })
              setNewPartName('')
              setNewPartSku('')
              setNewPartCost('')
              setNewPartUnit('ea')
            }}
          >
            Add Part
          </Button>
        </div>
      </div>
    </div>
  )
}
