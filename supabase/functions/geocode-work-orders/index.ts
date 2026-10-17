import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try { return JSON.stringify(err) } catch { return String(err) }
}

const BATCH_SIZE = 15
const GEOCODE_DELAY_MS = 300
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000

function cleanAddress(raw: string, city: string | null, state: string | null): string {
  const idx = raw.search(/\bactive\b/i)
  if (idx !== -1) {
    const after = raw.slice(idx).replace(/^active\s*/i, '').trim()
    if (after) return after
  }
  return [raw.trim(), city, state].filter((p) => p && p.trim()).join(', ')
}

function addressKey(cleaned: string): string {
  return cleaned.trim().toLowerCase().replace(/\s+/g, ' ')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function geocodeOnce(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({
    benchmark: 'Public_AR_Current',
    format: 'json',
    address: query,
  })}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  const hit = data?.result?.addressMatches?.[0]
  if (!hit) return null
  const lat = Number(hit.coordinates?.y)
  const lng = Number(hit.coordinates?.x)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

Deno.serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ step: 'env_check', error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' }), { status: 500 })
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const url = new URL(req.url)
    if (url.searchParams.get('debug') === '1') {
      const rawQ = url.searchParams.get('q') ?? ''
      const cleaned = cleanAddress(rawQ, null, null)
      const result = await geocodeOnce(cleaned)
      return new Response(JSON.stringify({ cleaned, result }), { headers: { 'Content-Type': 'application/json' } })
    }

    const retryCutoff = new Date(Date.now() - RETRY_FAILED_AFTER_MS).toISOString()
    const { data: pending, error: selErr } = await supabase
      .from('work_orders')
      .select('wo, address, city, state')
      .is('lat', null)
      .not('address', 'is', null)
      .neq('address', '')
      .or(`geocode_attempted_at.is.null,geocode_attempted_at.lt.${retryCutoff}`)
      .order('geocode_attempted_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE)

    if (selErr) {
      return new Response(JSON.stringify({ step: 'select', error: selErr }), { status: 500 })
    }

    const rows = pending ?? []
    if (rows.length === 0) {
      return new Response(JSON.stringify({ batch: 0, geocoded: 0, failed: 0, message: 'nothing pending' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const keyed = rows.map((r) => {
      const cleaned = cleanAddress(r.address, r.city, r.state)
      return { ...r, key: addressKey(cleaned), cleaned }
    })
    const uniqueKeys = [...new Set(keyed.map((r) => r.key))]

    const { data: cacheRows, error: cacheErr } = await supabase
      .from('geocode_cache')
      .select('address_key, lat, lng, source')
      .in('address_key', uniqueKeys)
      .eq('source', 'census')
    if (cacheErr) {
      return new Response(JSON.stringify({ step: 'cache_lookup', error: cacheErr }), { status: 500 })
    }

    const cache = new Map<string, { lat: number | null; lng: number | null }>()
    for (const c of cacheRows ?? []) cache.set(c.address_key, { lat: c.lat, lng: c.lng })

    let liveCalls = 0
    for (const row of keyed) {
      if (cache.has(row.key)) continue
      if (liveCalls > 0) await sleep(GEOCODE_DELAY_MS)
      liveCalls++
      let result: { lat: number; lng: number } | null = null
      try {
        result = await geocodeOnce(row.cleaned)
      } catch {
        result = null
      }
      cache.set(row.key, result ?? { lat: null, lng: null })
      await supabase
        .from('geocode_cache')
        .upsert(
          { address_key: row.key, lat: result?.lat ?? null, lng: result?.lng ?? null, source: 'census' },
          { onConflict: 'address_key' }
        )
    }

    const now = new Date().toISOString()
    let geocoded = 0
    let failed = 0
    for (const row of keyed) {
      const hit = cache.get(row.key)
      const updates: Record<string, unknown> = { geocode_attempted_at: now }
      if (hit?.lat != null && hit?.lng != null) {
        updates.lat = hit.lat
        updates.lng = hit.lng
        geocoded++
      } else {
        failed++
      }
      await supabase.from('work_orders').update(updates).eq('wo', row.wo)
    }

    return new Response(JSON.stringify({ batch: rows.length, uniqueAddresses: uniqueKeys.length, liveCalls, geocoded, failed }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ step: 'unhandled', error: errMsg(err) }), { status: 500 })
  }
})
