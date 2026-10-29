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

// Fixed Excel column order -> Supabase column names. Kept only as a FALLBACK
// now (see FIELD_PATTERNS below) for whichever field a sheet's real header
// row doesn't name recognizably -- not trusted as the primary way to find
// a column anymore. Different entities' workbooks turned out to not agree
// on column order past "Quote Sent On": some insert a "Completion Date"
// column before Invoiced On that this map has no slot for, which used to
// mean Invoiced On got read from the wrong position (and Completion Date
// silently dropped). Reading every column by its real header name fixes
// that regardless of where it sits. Index 5 ('col_blank1') is unused --
// it's a leftover placeholder kept only so the other fields' positions
// below it still line up with their original indexes. `client` isn't in
// this map at all: it comes from the table's worksheet/tab name instead
// (see syncOneSource), not from any column in the sheet.
const COLUMN_MAP = [
  'wo', 'dispatcher', 'status', 'wo_date', 'eta',
  'col_blank1', 'trade', 'subtrade', 'address', 'city', 'state',
  'nte', 'nte_approved', 'cost', 'profit_pct', 'description',
  'quote_sent_on', 'admin_notes', 'tl_notes', 'invoiced_on',
]

// The fixed position each field falls back to when its name can't be found
// in a given sheet's own header row (built once from COLUMN_MAP above).
const FALLBACK_INDEX: Record<string, number> = {}
COLUMN_MAP.forEach((col, i) => {
  if (col !== 'col_blank1') FALLBACK_INDEX[col] = i
})

// Every field except client (which comes from the worksheet/tab name, not
// a column -- see syncOneSource), matched against a sheet's real header
// text instead of trusting its position. Headers vary a bit sheet to sheet
// (trailing spaces, "WorkOrder" vs "Work Orders", a stray typo like
// "Completeion Date") so these are forgiving on whitespace/plural/typo,
// but anchored so e.g. "NTE" never matches "NTE Approved". Order doesn't
// matter: every pattern is anchored to the *whole* trimmed header, so two
// patterns can never both claim the same real column.
const FIELD_PATTERNS: [string, RegExp][] = [
  ['wo', /^work\s*orders?$/i],
  ['dispatcher', /^dispatchers?$/i],
  ['status', /^status$/i],
  ['wo_date', /^received\s+date$/i],
  ['eta', /^eta$/i],
  ['trade', /^trade$/i],
  ['subtrade', /^sub\s*trade$/i],
  ['address', /^add?ress$/i],
  ['city', /^city$/i],
  ['state', /^state$/i],
  ['nte_approved', /^nte\s+approved$/i],
  ['nte', /^nte$/i],
  ['cost', /^cost$/i],
  ['profit_pct', /^profit\s*%?$/i],
  ['description', /^description$/i],
  ['quote_sent_on', /^quote\s+sent\s+on\s*\??$/i],
  ['admin_notes', /^admin\s*notes?$/i],
  ['tl_notes', /^tl\s*notes?$/i],
  ['invoiced_on', /^invoiced\s+on\s*\??$/i],
]

// For one table's real header row, work out which column index each known
// field actually lives at. A field whose name can't be matched (a header
// that was renamed to something unrecognizable, e.g. a stray "Column1")
// falls back to its old fixed position rather than being dropped outright --
// no worse than the previous behavior, and `fallbackFields` in the sync
// result flags it so a real mismatch doesn't pass silently.
function resolveColumnIndexes(tableColumns: { name: string; index: number }[]): {
  indexes: Record<string, number>
  fallbackFields: string[]
} {
  const indexes: Record<string, number> = {}
  const fallbackFields: string[] = []
  const used = new Set<number>()
  for (const [col, pattern] of FIELD_PATTERNS) {
    const match = tableColumns.find((c) => !used.has(c.index) && pattern.test((c.name ?? '').trim()))
    if (match) {
      indexes[col] = match.index
      used.add(match.index)
    } else if (FALLBACK_INDEX[col] !== undefined) {
      indexes[col] = FALLBACK_INDEX[col]
      fallbackFields.push(col)
    }
  }
  return { indexes, fallbackFields }
}

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
  id: string
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
    return { entity: source.entityName, table: source.tableName, step: 'token', error: tokenData }
  }
  const token = tokenData.access_token

  const shareId = encodeSharingUrl(source.shareUrl)
  const driveItemRes = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const driveItemData = await driveItemRes.json()
  if (!driveItemRes.ok) {
    return { entity: source.entityName, table: source.tableName, step: 'resolve_share', error: driveItemData }
  }
  const driveId = driveItemData.parentReference?.driveId
  const itemId = driveItemData.id
  if (!driveId || !itemId) {
    return { entity: source.entityName, table: source.tableName, step: 'resolve_share', error: 'missing driveId/itemId', raw: driveItemData }
  }

  // Look up the table's actual header row (to find every field by name --
  // see resolveColumnIndexes) and which worksheet/tab this table lives on,
  // in parallel. The tab name IS the client -- every entity's workbook is
  // organized one tab per client (e.g. "CBRE", "O'Reilly", "BrandPoint") --
  // so that's what fills work_orders.client, rather than trying to find a
  // "Store"/"Client" column inside the sheet (which, where one exists,
  // actually holds the specific store/brand being serviced, not the client).
  const [columnsRes, worksheetRes] = await Promise.all([
    fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${source.tableName}/columns?$select=name,index`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
    fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${source.tableName}/worksheet?$select=name`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
  ])
  const columnsData = await columnsRes.json()
  if (!columnsRes.ok) {
    return { entity: source.entityName, table: source.tableName, step: 'columns', error: columnsData, driveId, itemId }
  }
  const tableColumns: { name: string; index: number }[] = columnsData.value ?? []
  const { indexes: fieldIndex, fallbackFields } = resolveColumnIndexes(tableColumns)

  const worksheetData = await worksheetRes.json()
  const worksheetName: string | null = worksheetRes.ok ? ((worksheetData.name ?? '').trim() || null) : null
  const worksheetLookupError = worksheetRes.ok ? undefined : worksheetData

  const rowsRes = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${source.tableName}/rows`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const rowsData = await rowsRes.json()
  if (!rowsRes.ok) {
    return { entity: source.entityName, table: source.tableName, step: 'rows', error: rowsData, driveId, itemId }
  }

  // If the worksheet-name lookup above failed for some reason, leave
  // `client` out of the upserted columns entirely (rather than writing
  // null) so an already-correct value from a previous sync isn't wiped.
  const rawRows = rowsData.value ?? []
  const allRecords = rawRows.map((row: any) => {
    const values = row.values[0]
    const record: Record<string, any> = {}
    for (const col of Object.keys(fieldIndex)) {
      record[col] = sanitizeValue(col, values[fieldIndex[col]])
    }
    if (worksheetName) record.client = worksheetName
    record.entity_id = source.entityId
    return record
  })

  const records = allRecords.filter((r: any) => r.wo !== null && r.wo !== '')
  const skipped = allRecords.length - records.length

  if (records.length > 0) {
    const { error } = await supabase.from('work_orders').upsert(records, { onConflict: 'wo' })
    if (error) {
      return { entity: source.entityName, table: source.tableName, step: 'upsert', error, sampleMapped: records[0] }
    }
  }

  return {
    entity: source.entityName,
    table: source.tableName,
    synced: records.length,
    skipped,
    client: worksheetName,
    worksheetLookupError,
    fallbackFields: fallbackFields.length > 0 ? fallbackFields : undefined,
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
    // (An entity can now have several sources -- one per client sheet/table
    // -- so this matches on the same (entity_id, ms_table_name) pair the
    // table's unique constraint uses, not on entity_id alone.)
    if (SHARE_URL && TABLE_NAME) {
      const { data: gmn } = await supabase.from('entities').select('id').eq('name', 'Global Maintenance Network').maybeSingle()
      if (gmn) {
        await supabase.from('entity_work_order_sources').upsert(
          { entity_id: gmn.id, ms_share_url: SHARE_URL, ms_table_name: TABLE_NAME },
          { onConflict: 'entity_id,ms_table_name', ignoreDuplicates: true }
        )
      }
    }

    const { data: sourceRows, error: sourcesErr } = await supabase
      .from('entity_work_order_sources')
      .select('id, entity_id, ms_share_url, ms_table_name, ms_tenant_id, ms_client_id, ms_client_secret, entities(name)')
      .eq('active', true)
    if (sourcesErr) {
      return new Response(JSON.stringify({ step: 'load_sources', error: sourcesErr }), { status: 500 })
    }

    const sources: SourceConfig[] = (sourceRows ?? []).map((row: any) => ({
      id: row.id,
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

      // For every table found (not just the one currently configured),
      // also fetch its header row -- so a caller can compare each
      // client sheet's actual column layout against COLUMN_MAP before
      // wiring that sheet up as a new source. Read-only, diagnose-only.
      const sampleRows = url.searchParams.get('sampleRows') === '1'
      const tableList: any[] = tblRes.ok ? (tblData.value ?? []) : []
      const tablesWithColumns = await Promise.all(
        tableList.map(async (t: any) => {
          const colRes = await fetch(
            `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${t.id}/columns?$select=name,index`,
            { headers: { Authorization: `Bearer ${token}` } }
          )
          const colData = await colRes.json()
          const entry: Record<string, unknown> = {
            name: t.name,
            worksheet: t.worksheet?.name ?? null,
            columns: colRes.ok ? (colData.value ?? []).map((c: any) => c.name) : { error: colData },
          }
          // Optional (?sampleRows=1): include the first couple of data rows
          // too, so a caller can see actual cell content (e.g. what a
          // "Store" column really holds) without touching work_orders.
          if (sampleRows) {
            const rowsRes = await fetch(
              `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${t.id}/rows?$top=2`,
              { headers: { Authorization: `Bearer ${token}` } }
            )
            const rowsData = await rowsRes.json()
            entry.sampleRows = rowsRes.ok ? (rowsData.value ?? []).map((r: any) => r.values[0]) : { error: rowsData }
          }
          return entry
        })
      )

      return new Response(JSON.stringify({
        diagnose: true,
        entity: target.entityName,
        currentlySyncedTable: target.tableName,
        columnMapReference: COLUMN_MAP,
        worksheets: wsRes.ok ? wsData.value : { error: wsData },
        tables: tblRes.ok ? tblData.value : { error: tblData },
        tableColumns: tablesWithColumns,
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
        result = { entity: source.entityName, table: source.tableName, step: 'unhandled', error: errMsg(err) }
      }
      results.push(result)
      // Match on this row's own id -- an entity can now have several
      // source rows (one per client sheet/table), so matching on
      // entity_id alone would stomp every sibling row with this one's
      // result.
      await supabase
        .from('entity_work_order_sources')
        .update({ last_synced_at: new Date().toISOString(), last_sync_result: result })
        .eq('id', source.id)
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
