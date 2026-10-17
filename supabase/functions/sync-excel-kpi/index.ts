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

Deno.serve(async (req) => {
  try {
    const TENANT_ID = Deno.env.get('MS_TENANT_ID')
    const CLIENT_ID = Deno.env.get('MS_CLIENT_ID')
    const CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET')
    const SHARE_URL = Deno.env.get('MS_SHARE_URL')
    const TABLE_NAME = Deno.env.get('MS_TABLE_NAME')
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    const missing = Object.entries({ TENANT_ID, CLIENT_ID, CLIENT_SECRET, SHARE_URL, TABLE_NAME, SUPABASE_URL, SERVICE_ROLE_KEY })
      .filter(([, v]) => !v).map(([k]) => k)
    if (missing.length > 0) {
      return new Response(JSON.stringify({ step: 'env_check', error: `Missing env vars: ${missing.join(', ')}` }), { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!)

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID!,
          client_secret: CLIENT_SECRET!,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      }
    )
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) {
      return new Response(JSON.stringify({ step: 'token', error: tokenData }), { status: 500 })
    }
    const token = tokenData.access_token

    const shareId = encodeSharingUrl(SHARE_URL!)
    const driveItemRes = await fetch(
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const driveItemData = await driveItemRes.json()
    if (!driveItemRes.ok) {
      return new Response(JSON.stringify({ step: 'resolve_share', error: driveItemData, shareId }), { status: 500 })
    }
    const driveId = driveItemData.parentReference?.driveId
    const itemId = driveItemData.id
    if (!driveId || !itemId) {
      return new Response(JSON.stringify({ step: 'resolve_share', error: 'missing driveId/itemId', raw: driveItemData }), { status: 500 })
    }

    // Diagnostic mode (?diagnose=1): report every worksheet and every table in
    // the whole workbook, instead of running the normal sync. Lets us see
    // whether there is other data (other tabs / other tables) this sync never
    // touches, since the normal sync only ever reads the one table named by
    // MS_TABLE_NAME.
    const url = new URL(req.url)
    if (url.searchParams.get('diagnose') === '1') {
      const [wsRes, tblRes] = await Promise.all([
        fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/worksheets?$select=id,name,position,visibility`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables?$select=id,name,worksheet&$expand=worksheet($select=name)`, { headers: { Authorization: `Bearer ${token}` } }),
      ])
      const wsData = await wsRes.json()
      const tblData = await tblRes.json()
      return new Response(JSON.stringify({
        diagnose: true,
        currentlySyncedTable: TABLE_NAME,
        worksheets: wsRes.ok ? wsData.value : { error: wsData },
        tables: tblRes.ok ? tblData.value : { error: tblData },
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    // Look up the table's actual header row so we can find the store/client
    // column by name instead of assuming a fixed position for it.
    const columnsRes = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${TABLE_NAME}/columns?$select=name,index`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const columnsData = await columnsRes.json()
    if (!columnsRes.ok) {
      return new Response(JSON.stringify({ step: 'columns', error: columnsData, driveId, itemId }), { status: 500 })
    }
    const tableColumns: { name: string; index: number }[] = columnsData.value ?? []
    const clientColumn = tableColumns.find((c) => CLIENT_HEADER_PATTERN.test(c.name ?? ''))
    const clientColumnIndex = clientColumn ? clientColumn.index : null

    const rowsRes = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables/${TABLE_NAME}/rows`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const rowsData = await rowsRes.json()
    if (!rowsRes.ok) {
      return new Response(JSON.stringify({ step: 'rows', error: rowsData, driveId, itemId }), { status: 500 })
    }

    const rawRows = rowsData.value ?? []
    const allRecords = rawRows.map((row: any) => {
      const values = row.values[0]
      const record: Record<string, any> = {}
      COLUMN_MAP.forEach((col, i) => {
        if (col !== 'col_blank1') record[col] = sanitizeValue(col, values[i])
      })
      record.client = clientColumnIndex !== null ? sanitizeValue('client', values[clientColumnIndex]) : null
      return record
    })

    const records = allRecords.filter((r) => r.wo !== null && r.wo !== '')
    const skipped = allRecords.length - records.length

    if (records.length > 0) {
      const { error } = await supabase.from('work_orders').upsert(records, { onConflict: 'wo' })
      if (error) {
        return new Response(JSON.stringify({ step: 'upsert', error, sampleMapped: records[0] }), { status: 500 })
      }
    }

    return new Response(JSON.stringify({
      synced: records.length,
      skipped,
      clientColumnFound: clientColumn ? clientColumn.name : null,
      tableColumns: tableColumns.map((c) => c.name),
    }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ step: 'unhandled', error: errMsg(err) }), { status: 500 })
  }
})
