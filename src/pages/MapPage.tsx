import { useWorkOrders } from '../hooks/useWorkOrders'
import { WorkOrdersMap } from '../components/WorkOrdersMap'
import { PageHeader } from '../components/ui'

export function MapPage() {
  const { wos, loading } = useWorkOrders()

  if (loading) {
    return <p className="text-sm text-ink-faint py-8 text-center">Loading work orders...</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Map" description="Every work order with a known address, plotted by site." />
      <WorkOrdersMap workOrders={wos} height={560} />
    </div>
  )
}
