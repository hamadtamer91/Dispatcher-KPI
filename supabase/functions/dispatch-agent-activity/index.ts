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
const INBOX_LIMIT = 40
const APPROVALS_LIMIT = 20
// Live transcript lines accumulate on ai_dispatch_live_lines while a call is
// in progress and have no row yet in ai_dispatch_call_events (that's written
// only once the call ends) -- so "is a call active" is approximated as "has
// a line in the last few minutes with no matching call_events.call_sid".
const LIVE_LINES_WINDOW_MINUTES = 10

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
    // When called with a dispatcherName, scope the whole response to just
    // that dispatcher's own orders (and only the calls/alerts/inbox/approvals
    // tied to one of those orders) -- used for the dispatcher role's own
    // Dispatch Agent tab, so a dispatcher only sees what they personally
    // added through it. Omitted (admin view) -> no filtering, same as before.
    const requestBody = await req.json().catch(() => ({}))
    const dispatcherName = typeof requestBody?.dispatcherName === 'string' && requestBody.dispatcherName.trim()
      ? requestBody.dispatcherName.trim()
      : null

    const DISPATCH_URL = Deno.env.get('DISPATCH_AGENT_SUPABASE_URL')
    const DISPATCH_SERVICE_ROLE_KEY = Deno.env.get('DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY')

    if (!DISPATCH_URL || !DISPATCH_SERVICE_ROLE_KEY) {
      // Temporary diagnostic: never logs the secret values themselves, only
      // whether each one is present, so we can tell from the function logs
      // which (if either) is missing without the frontend seeing anything
      // sensitive.
      console.error('env_check failed', {
        has_url: !!DISPATCH_URL,
        has_key: !!DISPATCH_SERVICE_ROLE_KEY,
      })
      return jsonResponse(
        { step: 'env_check', error: 'Missing DISPATCH_AGENT_SUPABASE_URL / DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY' },
        500,
      )
    }

    const dispatch = createClient(DISPATCH_URL, DISPATCH_SERVICE_ROLE_KEY)
    const liveLinesSince = new Date(Date.now() - LIVE_LINES_WINDOW_MINUTES * 60 * 1000).toISOString()

    let ordersQuery = dispatch
      .from('ai_dispatch_orders')
      .select('id, title, trade, location, description, urgency, repair_ceiling, assessment_target, ground_rules, status, auto_dispatch, updated_at, assigned_technician_id, office_note, created_by_dispatcher')
      .order('updated_at', { ascending: false })
      .limit(ORDERS_LIMIT)
    if (dispatcherName) ordersQuery = ordersQuery.eq('created_by_dispatcher', dispatcherName)

    const [ordersRes, techsRes, eventsRes, alertsRes, inboxRes, approvalsRes, liveLinesRes] = await Promise.all([
      ordersQuery,
      dispatch
        .from('ai_dispatch_technicians')
        .select('id, order_id, name, company, phone, status'),
      dispatch
        .from('ai_dispatch_call_events')
        .select('id, order_id, technician_id, call_sid, provider, event_type, ended_reason, duration_seconds, cost, summary, transcript, recording_url, created_at')
        .order('created_at', { ascending: false })
        .limit(EVENTS_LIMIT),
      dispatch
        .from('ai_dispatch_alerts')
        .select('id, level, message, source, context, order_id, technician_id, created_at')
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(ALERTS_LIMIT),
      // Inbound/reception calls -- someone calling Raley's number back.
      // Not currently surfaced anywhere else in dispatcher-kpi.
      dispatch
        .from('ai_dispatch_inbox')
        .select('id, call_id, phone, caller_name, technician_id, order_id, reason, message, summary, transcript, recording_url, callback_requested, handled, created_at')
        .order('created_at', { ascending: false })
        .limit(INBOX_LIMIT),
      dispatch
        .from('ai_dispatch_approvals')
        .select('id, order_id, kind, requested_amount, decided_amount, status, decision_note, created_at')
        .order('created_at', { ascending: false })
        .limit(APPROVALS_LIMIT),
      dispatch
        .from('ai_dispatch_live_lines')
        .select('call_sid, role, text, created_at')
        .gte('created_at', liveLinesSince)
        .order('created_at', { ascending: true }),
    ])

    for (const [step, res] of [
      ['orders', ordersRes], ['technicians', techsRes], ['events', eventsRes], ['alerts', alertsRes],
      ['inbox', inboxRes], ['approvals', approvalsRes], ['live_lines', liveLinesRes],
    ] as const) {
      if (res.error) {
        console.error(`${step} query failed`, res.error)
        return jsonResponse({ step, error: res.error }, 500)
      }
    }

    const orders = ordersRes.data ?? []
    const techs = techsRes.data ?? []
    const events = eventsRes.data ?? []
    const alerts = alertsRes.data ?? []
    const inbox = inboxRes.data ?? []
    const approvals = approvalsRes.data ?? []
    const liveLines = liveLinesRes.data ?? []

    const techById = new Map(techs.map((t) => [t.id, t]))
    const orderTitleById = new Map(orders.map((o) => [o.id, o.title]))

    // Dispatcher-scoped view: only calls/alerts/inbox/approvals tied to one
    // of this dispatcher's own orders (orders itself is already scoped by
    // the query above). Anything with no order_id can't be attributed to
    // this dispatcher, so it's excluded rather than guessed at.
    const scopedOrderIds = dispatcherName ? new Set(orders.map((o) => o.id)) : null
    const inScope = (orderId: string | null) => !scopedOrderIds || (!!orderId && scopedOrderIds.has(orderId))
    const scopedEvents = events.filter((e) => inScope(e.order_id))
    const scopedAlerts = alerts.filter((a) => inScope(a.order_id))
    const scopedInbox = inbox.filter((i) => inScope(i.order_id))
    const scopedApprovals = approvals.filter((a) => inScope(a.order_id))

    // Call events/alerts can reference orders outside the latest ORDERS_LIMIT
    // window; backfill those titles with a small extra lookup rather than
    // showing "Unknown order" for anything slightly older.
    const missingOrderIds = [...new Set(
      [...scopedEvents.map((e) => e.order_id), ...scopedAlerts.map((a) => a.order_id), ...scopedInbox.map((i) => i.order_id), ...scopedApprovals.map((a) => a.order_id)]
        .filter((id): id is string => !!id && !orderTitleById.has(id))
    )]
    if (missingOrderIds.length > 0) {
      const { data: extraOrders } = await dispatch
        .from('ai_dispatch_orders')
        .select('id, title')
        .in('id', missingOrderIds)
      for (const o of extraOrders ?? []) orderTitleById.set(o.id, o.title)
    }

    // Group live transcript lines by call -- a call counts as "active" only
    // if it has no matching call_events row yet (that row is written once
    // the call ends), otherwise it's just the tail of a call already shown
    // in Recent Calls.
    const eventCallSids = new Set(events.map((e) => e.call_sid).filter((s): s is string => !!s))
    const liveByCallSid = new Map<string, typeof liveLines>()
    for (const line of liveLines) {
      if (!line.call_sid || eventCallSids.has(line.call_sid)) continue
      const existing = liveByCallSid.get(line.call_sid)
      if (existing) existing.push(line)
      else liveByCallSid.set(line.call_sid, [line])
    }

    const responseBody = {
      orders: orders.map((o) => ({
        id: o.id,
        title: o.title,
        trade: o.trade,
        location: o.location,
        description: o.description,
        urgency: o.urgency,
        repair_ceiling: o.repair_ceiling,
        assessment_target: o.assessment_target,
        ground_rules: o.ground_rules,
        status: o.status,
        auto_dispatch: o.auto_dispatch,
        updated_at: o.updated_at,
        office_note: o.office_note ?? null,
        assigned_technician_id: o.assigned_technician_id,
        assigned_technician: o.assigned_technician_id && techById.has(o.assigned_technician_id)
          ? (() => {
              const t = techById.get(o.assigned_technician_id)!
              return { name: t.name, company: t.company ?? null, phone: t.phone ?? null }
            })()
          : null,
        // Every technician Raley has sourced/contacted for this order, not
        // just the one it ended up assigning -- the dispatcher needs the
        // full candidate list to place a manual call to any of them.
        technicians: techs
          .filter((t) => t.order_id === o.id)
          .map((t) => ({ id: t.id, name: t.name, company: t.company ?? null, phone: t.phone ?? null, status: t.status ?? null })),
      })),
      events: scopedEvents.map((e) => ({
        id: e.id,
        order_title: e.order_id ? orderTitleById.get(e.order_id) ?? null : null,
        technician_name: e.technician_id ? techById.get(e.technician_id)?.name ?? null : null,
        call_sid: e.call_sid ?? null,
        provider: e.provider,
        event_type: e.event_type,
        ended_reason: e.ended_reason,
        duration_seconds: e.duration_seconds,
        cost: e.cost ?? null,
        summary: e.summary,
        transcript: e.transcript ?? null,
        recording_url: e.recording_url ?? null,
        created_at: e.created_at,
      })),
      alerts: scopedAlerts.map((a) => ({
        id: a.id,
        level: a.level,
        message: a.message,
        source: a.source ?? null,
        context: a.context ?? null,
        order_title: a.order_id ? orderTitleById.get(a.order_id) ?? null : null,
        technician_name: a.technician_id ? techById.get(a.technician_id)?.name ?? null : null,
        created_at: a.created_at,
      })),
      // Inbound calls -- the "incoming" half of call tracking. Outbound
      // dispatch calls are `events` above; these are calls someone placed
      // TO Raley's own number (a callback, a question, etc).
      inbox: scopedInbox.map((i) => ({
        id: i.id,
        call_id: i.call_id ?? null,
        phone: i.phone ?? null,
        caller_name: i.caller_name ?? null,
        technician_name: i.technician_id ? techById.get(i.technician_id)?.name ?? null : null,
        order_title: i.order_id ? orderTitleById.get(i.order_id) ?? null : null,
        reason: i.reason ?? null,
        message: i.message ?? null,
        summary: i.summary ?? null,
        transcript: i.transcript ?? null,
        recording_url: i.recording_url ?? null,
        callback_requested: !!i.callback_requested,
        handled: !!i.handled,
        created_at: i.created_at,
      })),
      approvals: scopedApprovals.map((a) => ({
        id: a.id,
        order_title: a.order_id ? orderTitleById.get(a.order_id) ?? null : null,
        kind: a.kind ?? null,
        requested_amount: a.requested_amount ?? null,
        decided_amount: a.decided_amount ?? null,
        status: a.status,
        decision_note: a.decision_note ?? null,
        created_at: a.created_at,
      })),
      // Calls in progress right now, with their transcript so far. Live
      // lines carry no order_id at all, so there's no way to attribute one
      // to a specific dispatcher's orders -- omit them entirely in the
      // scoped view rather than show a call that might belong to someone
      // else's job.
      live_calls: dispatcherName
        ? []
        : [...liveByCallSid.entries()].map(([call_sid, lines]) => ({
            call_sid,
            started_at: lines[0].created_at,
            updated_at: lines[lines.length - 1].created_at,
            lines: lines.map((l) => ({ role: l.role, text: l.text, created_at: l.created_at })),
          })),
      fetched_at: new Date().toISOString(),
    }

    return jsonResponse(responseBody)
  } catch (err) {
    console.error('unhandled error', errMsg(err))
    return jsonResponse({ step: 'unhandled', error: errMsg(err) }, 500)
  }
})
