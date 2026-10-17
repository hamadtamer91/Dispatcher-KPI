import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Read-only bridge to the SEPARATE "nexafix-dispatch" Supabase project that
// backs the AI dispatch agent ("Raley") -- a different system entirely from
// this project's own work_orders/proposals tables (see README). This function
// changes nothing there: it only reads, using that project's service role key
// (set as the DISPATCH_AGENT_SUPABASE_* secrets below, never shipped to the
// browser) so the dashboard can show recent agent activity without the two
// systems' databases, auth, or RLS needing to know about each other.
//
// There is deliberately no join key back to this project's work_orders --
// ai_dispatch_orders has no concept of a work order number. This is a
// standalone activity feed, not a per-job integration.

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try { return JSON.stringify(err) } catch { return String(err) }
}

const ORDERS_LIMIT = 25
const EVENTS_LIMIT = 30
const ALERTS_LIMIT = 20

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const DISPATCH_URL = Deno.env.get('DISPATCH_AGENT_SUPABASE_URL')
    const DISPATCH_SERVICE_ROLE_KEY = Deno.env.get('DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY')

    if (!DISPATCH_URL || !DISPATCH_SERVICE_ROLE_KEY) {
      return jsonResponse(
        { step: 'env_check', error: 'Missing DISPATCH_AGENT_SUPABASE_URL / DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY' },
        500,
      )
    }

    const dispatch = createClient(DISPATCH_URL, DISPATCH_SERVICE_ROLE_KEY)

    const [ordersRes, techsRes, eventsRes, alertsRes] = await Promise.all([
      dispatch
        .from('ai_dispatch_orders')
        .select('id, title, trade, location, urgency, status, updated_at, assigned_technician_id')
        .order('updated_at', { ascending: false })
        .limit(ORDERS_LIMIT),
      dispatch
        .from('ai_dispatch_technicians')
        .select('id, order_id, name, company, phone'),
      dispatch
        .from('ai_dispatch_call_events')
        .select('id, order_id, technician_id, provider, event_type, ended_reason, duration_seconds, summary, created_at')
        .order('created_at', { ascending: false })
        .limit(EVENTS_LIMIT),
      dispatch
        .from('ai_dispatch_alerts')
        .select('id, level, message, order_id, created_at')
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(ALERTS_LIMIT),
    ])

    for (const [step, res] of [['orders', ordersRes], ['technicians', techsRes], ['events', eventsRes], ['alerts', alertsRes]] as const) {
      if (res.error) {
        return jsonResponse({ step, error: res.error }, 500)
      }
    }

    const orders = ordersRes.data ?? []
    const techs = techsRes.data ?? []
    const events = eventsRes.data ?? []
    const alerts = alertsRes.data ?? []

    const techById = new Map(techs.map((t) => [t.id, t]))
    const orderTitleById = new Map(orders.map((o) => [o.id, o.title]))
    // Call events/alerts can reference orders outside the latest ORDERS_LIMIT
    // window; backfill those titles with a small extra lookup rather than
    // showing "Unknown order" for anything slightly older.
    const missingOrderIds = [...new Set(
      [...events.map((e) => e.order_id), ...alerts.map((a) => a.order_id)]
        .filter((id): id is string => !!id && !orderTitleById.has(id))
    )]
    if (missingOrderIds.length > 0) {
      const { data: extraOrders } = await dispatch
        .from('ai_dispatch_orders')
        .select('id, title')
        .in('id', missingOrderIds)
      for (const o of extraOrders ?? []) orderTitleById.set(o.id, o.title)
    }

    const responseBody = {
      orders: orders.map((o) => ({
        id: o.id,
        title: o.title,
        trade: o.trade,
        location: o.location,
        urgency: o.urgency,
        status: o.status,
        updated_at: o.updated_at,
        assigned_technician: o.assigned_technician_id && techById.has(o.assigned_technician_id)
          ? (() => {
              const t = techById.get(o.assigned_technician_id)!
              return { name: t.name, company: t.company ?? null, phone: t.phone ?? null }
            })()
          : null,
      })),
      events: events.map((e) => ({
        id: e.id,
        order_title: e.order_id ? orderTitleById.get(e.order_id) ?? null : null,
        technician_name: e.technician_id ? techById.get(e.technician_id)?.name ?? null : null,
        provider: e.provider,
        event_type: e.event_type,
        ended_reason: e.ended_reason,
        duration_seconds: e.duration_seconds,
        summary: e.summary,
        created_at: e.created_at,
      })),
      alerts: alerts.map((a) => ({
        id: a.id,
        level: a.level,
        message: a.message,
        order_title: a.order_id ? orderTitleById.get(a.order_id) ?? null : null,
        created_at: a.created_at,
      })),
      fetched_at: new Date().toISOString(),
    }

    return jsonResponse(responseBody)
  } catch (err) {
    return jsonResponse({ step: 'unhandled', error: errMsg(err) }, 500)
  }
})
