// Lightweight chart primitives for the Analytics page. No charting library dependency --
// plain HTML/CSS bars + a small inline SVG for the trend line, built against the
// dashboard's existing design tokens (white cards, gray-50 page, Tailwind utility classes).

export const CHART_COLORS = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  gray: '#aeada7',
  good: '#0ca30c',
  critical: '#d03b3b',
  divergingRed: '#e34948',
  gridline: '#e1e0d9',
  muted: '#898781',
}

export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-3xl font-bold text-gray-900 mt-1.5 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export interface BarDatum {
  label: string
  value: number
  color?: string
}

/** Horizontal bar chart -- reads best for categorical labels (status names, dispatcher names). */
export function HBarChart({ data, unit = '', emptyText = 'No data yet.' }: { data: BarDatum[]; unit?: string; emptyText?: string }) {
  if (!data.length) return <p className="text-sm text-gray-400 py-6 text-center">{emptyText}</p>
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div className="space-y-2.5">
      {data.map((d) => (
        <div key={d.label} title={`${d.label}: ${d.value}${unit}`}>
          <div className="flex justify-between gap-3 text-xs mb-1">
            <span className="text-gray-700 font-medium truncate">{d.label}</span>
            <span className="text-gray-500 tabular-nums shrink-0">{d.value}{unit}</span>
          </div>
          <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, backgroundColor: d.color ?? CHART_COLORS.blue }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export interface HistBin {
  label: string
  value: number
  color?: string
}

/** Vertical column histogram -- bars anchored to a shared baseline. */
export function Histogram({ bins, height = 150, unit = '' }: { bins: HistBin[]; height?: number; unit?: string }) {
  const max = Math.max(1, ...bins.map((b) => b.value))
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {bins.map((b) => (
          <div key={b.label} className="flex-1 flex flex-col items-center justify-end h-full group min-w-0">
            <span className="text-[11px] text-gray-500 mb-1 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
              {b.value}{unit}
            </span>
            <div
              title={`${b.label}: ${b.value}${unit}`}
              className="w-full rounded-t"
              style={{
                height: `${(b.value / max) * 100}%`,
                minHeight: b.value > 0 ? 3 : 0,
                backgroundColor: b.color ?? CHART_COLORS.blue,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        {bins.map((b) => (
          <div key={b.label} className="flex-1 text-center text-[11px] text-gray-400 truncate min-w-0">
            {b.label}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Single-series trend line with a filled area, gridlines, and per-point hover tooltips. */
export function TrendLine({ points, height = 150, unit = '' }: { points: { label: string; value: number }[]; height?: number; unit?: string }) {
  if (points.length < 2) {
    return <p className="text-sm text-gray-400 py-6 text-center">Not enough data yet for a trend.</p>
  }
  const max = Math.max(1, ...points.map((p) => p.value))
  const w = 100
  const h = 40
  const stepX = w / (points.length - 1)
  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: h - (p.value / max) * (h - 4) - 2,
    ...p,
  }))
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ')
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${h} L 0 ${h} Z`

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={w} y1={h * f} y2={h * f} stroke={CHART_COLORS.gridline} strokeWidth={0.3} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={areaPath} fill={CHART_COLORS.blue} fillOpacity={0.08} stroke="none" />
        <path d={linePath} fill="none" stroke={CHART_COLORS.blue} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {coords.map((c) => (
          <circle key={c.label} cx={c.x} cy={c.y} r={1.4} fill={CHART_COLORS.blue} vectorEffect="non-scaling-stroke">
            <title>{`${c.label}: ${c.value}${unit}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex mt-1.5">
        {points.map((p) => (
          <div key={p.label} className="flex-1 text-center text-[11px] text-gray-400 truncate min-w-0">
            {p.label}
          </div>
        ))}
      </div>
    </div>
  )
}

/** "2026-09" -> "Sep 26", for month-bucketed chart labels. */
export function formatMonth(ym: string): string {
  const [year, month] = ym.split('-').map(Number)
  const d = new Date(year, (month ?? 1) - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-4 pt-3 border-t border-gray-100">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: i.color }} />
          {i.label}
        </div>
      ))}
    </div>
  )
}
