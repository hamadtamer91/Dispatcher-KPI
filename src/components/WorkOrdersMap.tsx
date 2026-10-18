// Reusable Leaflet map of work orders, with search/store/status filters, site-level
// marker grouping (several jobs at the same address collapse into one pin with a count
// badge), and a status-colored legend. Used by the admin's full Map page, the admin's
// per-dispatcher detail page, and the dispatcher's own "My Jobs" view -- each just passes
// in whichever subset of work orders it wants plotted.
import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { DONE_STATUSES, REASSIGNED_STATUSES } from '../lib/kpi'
import { CHART_COLORS, Legend } from './charts'
import { STATUS_OPTIONS } from '../lib/types'
import type { WorkOrder } from '../lib/types'

function statusColor(status: string | null | undefined): string {
  const lower = (status ?? '').toLowerCase()
  if (DONE_STATUSES.has(lower)) return CHART_COLORS.good
  if (REASSIGNED_STATUSES.has(lower)) return CHART_COLORS.critical
  return CHART_COLORS.gray
}

/** One marker per physical site. A site with >1 job is colored by its "worst" outcome
 *  (any reassignment > not-yet-done > all done) and shows a count badge. */
function siteColor(jobs: WorkOrder[]): string {
  if (jobs.some((j) => REASSIGNED_STATUSES.has((j.status ?? '').toLowerCase()))) return CHART_COLORS.critical
  if (jobs.every((j) => DONE_STATUSES.has((j.status ?? '').toLowerCase()))) return CHART_COLORS.good
  return CHART_COLORS.gray
}

function pinIcon(color: string, count: number) {
  const size = count > 1 ? 30 : 24
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:9999px;background:${color};
      border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-size:12px;font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;
    ">${count > 1 ? count : ''}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}

interface Site {
  key: string
  lat: number
  lng: number
  jobs: WorkOrder[]
}

/** Recenters/refits the map whenever the plotted set of sites changes (filter change,
 *  more rows geocoded in the background, etc.) -- MapContainer itself only sets the
 *  view once on mount. */
function FitBounds({ sites }: { sites: Site[] }) {
  const map = useMap()
  useEffect(() => {
    if (!sites.length) return
    if (sites.length === 1) {
      map.setView([sites[0].lat, sites[0].lng], 13)
      return
    }
    const bounds = L.latLngBounds(sites.map((s) => [s.lat, s.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 })
  }, [map, sites])
  return null
}

function statusPill(status: string | null | undefined) {
  const color = statusColor(status)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      {status || 'Unknown'}
    </span>
  )
}

function JobDetail({ w }: { w: WorkOrder }) {
  return (
    <div className="py-2 first:pt-0 not-last:border-b border-line space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink text-sm">WO {w.wo}</span>
        {statusPill(w.status)}
      </div>
      <p className="text-xs text-ink-soft">
        <span className="text-ink-faint">Store:</span> {w.client || 'Unassigned'}
        {w.dispatcher && <> · <span className="text-ink-faint">Dispatcher:</span> {w.dispatcher}</>}
      </p>
      {(w.trade || w.subtrade) && (
        <p className="text-xs text-ink-soft">
          <span className="text-ink-faint">Trade:</span> {[w.trade, w.subtrade].filter(Boolean).join(' / ')}
        </p>
      )}
      <p className="text-xs text-ink-faint">
        {[w.address, w.city, w.state].filter(Boolean).join(', ')}
      </p>
      {(w.cost !== null || w.nte !== null) && (
        <p className="text-xs text-ink-soft">
          {w.cost !== null && <>Cost: ${w.cost?.toFixed(2)} </>}
          {w.nte !== null && <>· NTE: ${w.nte?.toFixed(2)}</>}
        </p>
      )}
      {w.wo_date && <p className="text-xs text-ink-faint">Opened {w.wo_date}</p>}
    </div>
  )
}

const US_CENTER: [number, number] = [39.5, -98.35]

export function WorkOrdersMap({
  workOrders,
  height = 560,
  showFilters = true,
}: {
  workOrders: WorkOrder[]
  height?: number
  showFilters?: boolean
}) {
  const [search, setSearch] = useState('')
  const [store, setStore] = useState('')
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())

  const stores = useMemo(
    () => [...new Set(workOrders.map((w) => w.client?.trim()).filter((v): v is string => Boolean(v)))].sort(),
    [workOrders]
  )

  const filtered = useMemo(() => {
    return workOrders.filter((w) => {
      if (store && (w.client?.trim() || '') !== store) return false
      if (statusFilter.size && !statusFilter.has(w.status ?? '')) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const hay = [w.wo, w.dispatcher, w.client, w.address, w.city, w.state, w.trade].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [workOrders, store, statusFilter, search])

  const sites = useMemo(() => {
    const map = new Map<string, Site>()
    for (const w of filtered) {
      if (w.lat == null || w.lng == null) continue
      const key = `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`
      if (!map.has(key)) map.set(key, { key, lat: w.lat, lng: w.lng, jobs: [] })
      map.get(key)!.jobs.push(w)
    }
    return [...map.values()]
  }, [filtered])

  const geocodedCount = filtered.filter((w) => w.lat != null && w.lng != null).length
  const pendingCount = filtered.filter((w) => w.lat == null && w.address).length
  const noAddressCount = filtered.filter((w) => !w.address).length

  const toggleStatus = (s: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  return (
    <div className="space-y-4">
      {showFilters && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Search WO #, store, dispatcher, address..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="field w-72"
          />
          <select
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className="field w-auto"
          >
            <option value="">All stores</option>
            {stores.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_OPTIONS.map((s) => {
              const active = statusFilter.has(s)
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`text-xs font-semibold px-2.5 py-1.5 rounded-full border transition-colors ${
                    active
                      ? 'bg-brand-600 border-brand-600 text-white'
                      : 'bg-white border-line text-ink-soft hover:bg-canvas'
                  }`}
                >
                  {s}
                </button>
              )
            })}
            {statusFilter.size > 0 && (
              <button onClick={() => setStatusFilter(new Set())} className="text-xs font-semibold text-ink-faint hover:text-ink-soft px-2 py-1.5">
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-ink-faint">
        {geocodedCount} of {filtered.length} work orders placed on the map across {sites.length} site{sites.length === 1 ? '' : 's'}.
        {pendingCount > 0 && ` ${pendingCount} more are being located in the background (checks every couple of minutes).`}
        {noAddressCount > 0 && ` ${noAddressCount} have no address on file.`}
      </p>

      <div className="panel overflow-hidden" style={{ height }}>
        <MapContainer center={US_CENTER} zoom={4} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds sites={sites} />
          {sites.map((site) => (
            <Marker key={site.key} position={[site.lat, site.lng]} icon={pinIcon(siteColor(site.jobs), site.jobs.length)}>
              <Popup maxHeight={320} minWidth={240}>
                <div className="max-h-72 overflow-y-auto">
                  {site.jobs.map((w) => <JobDetail key={w.wo} w={w} />)}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      <Legend
        items={[
          { label: 'All jobs at site completed', color: CHART_COLORS.good },
          { label: 'Has a reassigned job', color: CHART_COLORS.critical },
          { label: 'In progress', color: CHART_COLORS.gray },
        ]}
      />
    </div>
  )
}
