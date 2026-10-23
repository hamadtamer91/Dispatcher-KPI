import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function encodeSharingUrl(url: string): string {
  const base64 = btoa(url)
  const base64url = base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')
  return 'u!' + base64url
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try { return JSON.stringify(err) } catch { return String(err) }
}

// Fixed Excel column order -> Supabase column names, for every column EXCEPT
// the store/client one. That one's position in the sheet isn't locked down --
// it was added after the fact and may not sit at the literal last column --
// so instead of trusting a fixed index for it, we look up the table's real
// header row and find whichever column is named like "Store" or "Client".
// This also means it keeps working if more columns get added after it later.
const COLUMN_MAP = [
  'wo', 'dispatcher', 'status', 'wo_date', 'eta',
  'col_blank1', 'trade', 'subtrade', 'address', 'city', 'state',
  'nte', 'nte_approved', 'cost', 'profit_pct', 'description',
  'quote_sent_on', 'admin_notes', 'tl_notes', 'invoiced_on',
]

const CLIENT_HEADER_PATTERN = /store|client/i

const NUMERIC_COLS = new Set(['nte', 'cost', 'profit_pct'])
const DATE_COLS = new Set(['wo_date', 'eta', 'quote_sent_on', 'invoiced_on'])
const BOOL_COLS = new Set(['nte_approved'])
const EXCEL_ERRORS = new Set(['#VALUE!', '#DIV/0!', '#N/A', '#REF!', '#NAME?', '#NULL!', '#NUM!'])

function excelSerialToISODate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null
  const utcDays = Math.floor(serial - 25569)
  const d = new Date(utcDays * 86400 * 1000)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function sanitizeValue(col: string, raw: any): any {
  if (raw === '' || raw === undefined || raw === null) return null
  if (typeof raw === 'string' && EXCEL_ERRORS.has(raw.trim())) return null

  if (DATE_COLS.has(col)) {
    if (typeof raw === 'number') return excelSerialToISODate(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      return trimmed === '' ? null : trimmed
    }
    return null
  }

  if (BOOL_COLS.has(col)) {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'number') return raw !== 0
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase()
      if (v === '') return null
      if (['yes', 'y', 'true', '1', 'approved'].includes(v)) return true
      if (['no', 'n', 'false', '0'].includes(v)) return false
      return null
    }
    return null
  }

  if (NUMERIC_COLS.has(col)) {
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/[$,%\s]/g, '').trim()
      if (cleaned === '') return null
      const n = Number(cleaned)
      return Number.isNaN(n) ? null : n
    }
    return null
  }

  return typeof raw === 'string' ? raw : String(raw)
}

// One entity's Microsoft Graph workbook config, resolved from
// entity_work_order_sources with the shared MS_* env secrets as a fallback
// for tenantId/clientId/clientSecret when that row doesn't set its own
// (i.e. this entity's workbook lives under the same Microsoft 365
// tenant/app as whichever entity set those shared secrets up first).
interface SourceConfig {
  entityId: string
  entityName: string
  shareUrl: string
  tableName: string
  tenantId: string
  clientId: string
  clientSecret: string
}

async function syncOneSource(source: SourceConfig, supabase: ReturnType<typeof createClient>) {
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${source.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: source.clientId,
        client_secret: source.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    }
  )
  const tokenData = await tokenRes.json()
  if (!tokenRes.ok) {
    return { entity: source.entityName, step: 'token', error: tokenData }
  }
  const token = tokenData.access_token

  const shareId = encodeSharingUrl(source.shareUrl)
  const driveItemRes = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const driveItemData = await driveItemRes.json()
  if (!driveItemRes.ok) {
    return { entity: source.entityName, step: 'resolve_share', error: driveItemData }
  }
  const driveId = driveItemData.parentReference?.driveId
  const itemId = driveItemData.id
  if (!driveId || !itemId) {
    return { entity: source.entityName, step: 'resolve_share', error: 'missing driveId/itemId', raw: driveItemData }
  }

  // Look up the table's actual header row so we can find the store/client
  // column by name instead of assuming a fixed position for it.
  const columnsRes = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${source.tableName}/columns?$select=name,index`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const columnsData = await columnsRes.json()
  if (!columnsRes.ok) {
    return { entity: source.entityName, step: 'columns', error: columnsData, driveId, itemId }
  }
  const tableColumns: { name: string; index: number }[] = columnsData.value ?? []
  const clientColumn = tableColumns.find((c) => CLIENT_HEADER_PATTERN.test(c.name ?? ''))
  const clientColumnIndex = clientColumn ? clientColumn.index : null

  const rowsRes = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${source.tableName}/rows`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const rowsData = await rowsRes.json()
  if (!rowsRes.ok) {
    return { entity: source.entityName, step: 'rows', error: rowsData, driveId, itemId }
  }

  const rawRows = rowsData.value ?? []
  const allRecords = rawRows.map((row: any) => {
    const values = row.values[0]
    const record: Record<string, any> = {}
    COLUMN_MAP.forEach((col, i) => {
      if (col !== 'col_blank1') record[col] = sanitizeValue(col, values[i])
    })
    record.client = clientColumnIndex !== null ? sanitizeValue('client', values[clientColumnIndex]) : null
    record.entity_id = source.entityId
    return record
  })

  const records = allRecords.filter((r: any) => r.wo !== null && r.wo !== '')
  const skipped = allRecords.length - records.length

  if (records.length > 0) {
    const { error } = await supabase.from('work_orders').upsert(records, { onConflict: 'wo' })
    if (error) {
      return { entity: source.entityName, step: 'upsert', error, sampleMapped: records[0] }
    }
  }

  return {
    entity: source.entityName,
    synced: records.length,
    skipped,
    clientColumnFound: clientColumn ? clientColumn.name : null,
  }
}

Deno.serve(async (req) => {
  try {
    const TENANT_ID = Deno.env.get('MS_TENANT_ID')
    const CLIENT_ID = Deno.env.get('MS_CLIENT_ID')
    const CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET')
    const SHARE_URL = Deno.env.get('MS_SHARE_URL')
    const TABLE_NAME = Deno.env.get('MS_TABLE_NAME')
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ step: 'env_check', error: 'Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY' }), { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Bootstrap: Global Maintenance Network has been syncing via the shared
    // MS_* env vars since before entities/per-entity sources existed. Give
    // it a row here (never overwriting one that's already there) so every
    // entity's config -- this one included -- lives in one place going
    // forward, without ever having to know or re-enter the existing secret.
    if (SHARE_URL && TABLE_NAME) {
      const { data: gmn } = await supabase.from('entities').select('id').eq('name', 'Global Maintenance Network').maybeSingle()
      if (gmn) {
        await supabase.from('entity_work_order_sources').upsert(
          { entity_id: gmn.id, ms_share_url: SHARE_URL, ms_table_name: TABLE_NAME },
          { onConflict: 'entity_id', ignoreDuplicates: true }
        )
      }
    }

    const { data: sourceRows, error: sourcesErr } = await supabase
      .from('entity_work_order_sources')
      .select('entity_id, ms_share_url, ms_table_name, ms_tenant_id, ms_client_id, ms_client_secret, entities(name)')
      .eq('active', true)
    if (sourcesErr) {
      return new Response(JSON.stringify({ step: 'load_sources', error: sourcesErr }), { status: 500 })
    }

    const sources: SourceConfig[] = (sourceRows ?? []).map((row: any) => ({
      entityId: row.entity_id,
      entityName: row.entities?.name ?? row.entity_id,
      shareUrl: row.ms_share_url,
      tableName: row.ms_table_name,
      tenantId: row.ms_tenant_id || TENANT_ID || '',
      clientId: row.ms_client_id || CLIENT_ID || '',
      clientSecret: row.ms_client_secret || CLIENT_SECRET || '',
    }))

    if (sources.length === 0) {
      return new Response(JSON.stringify({ synced: 0, skipped: 0, note: 'No entity work order sources configured yet.' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Diagnostic mode (?diagnose=1[&entity=<name or id>]): report every
    // worksheet and every table in one entity's whole workbook, instead of
    // running the normal sync. Defaults to the first configured source when
    // no entity is named.
    const url = new URL(req.url)
    if (url.searchParams.get('diagnose') === '1') {
      const entityFilter = url.searchParams.get('entity')
      const target = entityFilter
        ? sources.find((s) => s.entityId === entityFilter || s.entityName.toLowerCase() === entityFilter.toLowerCase())
        : sources[0]
      if (!target) {
        return new Response(JSON.stringify({ error: `No configured source matches entity "${entityFilter}"`, availableEntities: sources.map((s) => s.entityName) }), { status: 400 })
      }

      const tokenRes = await fetch(
        `https://login.microsoftonline.com/${target.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: target.clientId,
            client_secret: target.clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
          }),
        }
      )
      const tokenData = await tokenRes.json()
      if (!tokenRes.ok) {
        return new Response(JSON.stringify({ step: 'token', error: tokenData, entity: target.entityName }), { status: 500 })
      }
      const token = tokenData.access_token

      const shareId = encodeSharingUrl(target.shareUrl)
      const driveItemRes = await fetch(
        `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const driveItemData = await driveItemRes.json()
      if (!driveItemRes.ok) {
        return new Response(JSON.stringify({ step: 'resolve_share', error: driveItemData, entity: target.entityName, shareId }), { status: 500 })
      }
      const driveId = driveItemData.parentReference?.driveId
      const itemId = driveItemData.id
      if (!driveId || !itemId) {
        return new Response(JSON.stringify({ step: 'resolve_share', error: 'missing driveId/itemId', raw: driveItemData, entity: target.entityName }), { status: 500 })
      }

      const [wsRes, tblRes] = await Promise.all([
        fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/worksheets?$select=id,name,position,visibility`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables?$select=id,name,worksheet&$expand=worksheet($select=name)`, { headers: { Authorization: `Bearer ${token}` } }),
      ])
      const wsData = await wsRes.json()
      const tblData = await tblRes.json()
      return new Response(JSON.stringify({
        diagnose: true,
        entity: target.entityName,
        currentlySyncedTable: target.tableName,
        worksheets: wsRes.ok ? wsData.value : { error: wsData },
        tables: tblRes.ok ? tblData.value : { error: tblData },
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    // Normal sync: run every configured entity's workbook, independently --
    // one entity's failure (bad credentials, a renamed table, etc) never
    // blocks the others from syncing.
    const results = []
    for (const source of sources) {
      let result: Record<string, unknown>
      try {
        result = await syncOneSource(source, supabase)
      } catch (err) {
        result = { entity: source.entityName, step: 'unhandled', error: errMsg(err) }
      }
      results.push(result)
      await supabase
        .from('entity_work_order_sources')
        .update({ last_synced_at: new Date().toISOString(), last_sync_result: result })
        .eq('entity_id', source.entityId)
    }

    const totalSynced = results.reduce((sum, r: any) => sum + (r.synced ?? 0), 0)
    const totalSkipped = results.reduce((sum, r: any) => sum + (r.skipped ?? 0), 0)

    return new Response(JSON.stringify({ synced: totalSynced, skipped: totalSkipped, results }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ step: 'unhandled', error: errMsg(err) }), { status: 500 })
  }
})
