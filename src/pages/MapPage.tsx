import { useWorkOrders } from '../hooks/useWorkOrders'
import { WorkOrdersMap } from '../components/WorkOrdersMap'

export function MapPage() {
  const { wos, loading } = useWorkOrders()

  if (loading) {
    return <p className="text-sm text-gray-400 py-8 text-center">Loading work orders...</p>
  }

  return <WorkOrdersMap workOrders={wos} height={560} />
}
