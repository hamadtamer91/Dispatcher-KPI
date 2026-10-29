import { useState } from 'react'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { WorkOrdersMap } from '../components/WorkOrdersMap'
import { PageHeader } from '../components/ui'

export function MapPage() {
  const { switchableEntities } = useEntityScope()
  // Only a super_admin has more than one entity to pick from -- RLS already
  // locks data_entry/dispatcher to their own, so the picker (and the point
  // of an "All Entities" option) only matters for them. Everyone else keeps
  // the plain single-entity map, same as before.
  const canPickEntity = switchableEntities.length > 0
  const [entityFilter, setEntityFilter] = useState('all')
  const { wos, loading } = useWorkOrders(canPickEntity ? entityFilter : undefined)

  if (loading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading work orders...</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Map"
        description="Every work order with a known address, plotted by site."
        actions={
          canPickEntity && (
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="field w-auto"
            >
              <option value="all">All Entities</option>
              {switchableEntities.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          )
        }
      />
      <WorkOrdersMap workOrders={wos} height={560} />
    </div>
  )
}
