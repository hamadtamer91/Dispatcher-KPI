// Write bridge into Raley (nexafix-voice-agent), the SEPARATE AI dispatch
// agent app -- a different system from this project's own work_orders/
// proposals tables (see README, and supabase/functions/dispatch-agent-activity
// for the read-only counterpart to this function).
//
// Two different write paths, depending on the action:
//
// 1. create_order / call_technician -- go through Raley's own API (POST
//    /api/orders, POST /api/calls-start), which does real work beyond a
//    plain row write (validation, auto-dispatch kickoff, and placing the
//    actual Vapi phone call). We log in with Raley's own admin password
//    (RALEY_ADMIN_PASSWORD, an Edge Function secret, never shipped to the
//    browser) and forward the request to Raley's real endpoint, so these
//    behave exactly as if done from Raley's own app.
//
// 2. update_order / reassign_technician / set_auto_dispatch / cancel_order --
//    Raley has no HTTP endpoint for editing an existing order, so these
//    write straight to the ai_dispatch_orders row using the SAME service
//    role credentials dispatch-agent-activity already uses to read it
//    (DISPATCH_AGENT_SUPABASE_URL / DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY,
//    project-level secrets, no new setup needed). This is safe to do
//    directly because Raley's own ongoing behavior is itself driven off this
//    same table: a pg_cron job on that project polls it every 5 minutes
//    (hitting Raley's /api/scheduler) and acts on whatever auto_dispatch /
//    assigned_technician_id / status currently say -- so a plain column
//    write here is picked up on Raley's own next pass exactly as if the
//    change had been made in Raley's own UI. Reassigning a technician this
//    way updates the record but does not itself notify that technician --
//    use "Call technician" for that if a confirmation call is wanted.
//
//   POST { action: "create_order", payload: {...order fields, createdByDispatcher?} }
//   POST { action: "call_technician", payload: { orderId, technicianId, purpose? } }
//   POST { action: "update_order", payload: { orderId, patch: {...order fields} } }
//   POST { action: "reassign_technician", payload: { orderId, technicianId } }  // technicianId: null clears it
//   POST { action: "set_auto_dispatch", payload: { orderId, autoDispatch } }
//   POST { action: "cancel_order", payload: { orderId } }
//   POST { action: "add_technician", payload: { orderId, name, company?, phone?, email?, notes? } }
//
// add_technician is a direct-DB insert, same as the other DB actions above --
// it's exactly what Raley's own "Manually added" technician path already
// does (every existing row in ai_dispatch_technicians has source =
// 'Manually added'; there's no separate AI-sourcing insert path to match),
// so a new row here is indistinguishable from one added in Raley's own UI.
// New rows start as status "Sourced" (Raley's own observed convention for a
// technician that's been added but not yet contacted) with attempts: 0, so
// the scheduler and "Call" button both treat it exactly like any other
// candidate for the order.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const RALEY_BASE_URL = 'https://nexafix-voice-agent-ngvs.vercel.app'

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try { return JSON.stringify(err) } catch { return String(err) }
}

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

type ApiAction = 'create_order' | 'call_technician'
type DbAction = 'update_order' | 'reassign_technician' | 'set_auto_dispatch' | 'cancel_order' | 'add_technician'
// Writes against ai_dispatch_inbox (the incoming-call log) rather than
// ai_dispatch_orders -- keyed by inboxId, not orderId, so it's handled in
// its own branch below before the orderId-required DB_ACTIONS branch.
type InboxAction = 'set_inbox_handled'
type Action = ApiAction | DbAction | InboxAction

const API_ACTIONS = new Set<Action>(['create_order', 'call_technician'])
const DB_ACTIONS = new Set<Action>(['update_order', 'reassign_technician', 'set_auto_dispatch', 'cancel_order', 'add_technician'])
const INBOX_ACTIONS = new Set<Action>(['set_inbox_handled'])

// Whitelisted editable columns -- never spread an arbitrary patch object
// straight into a Postgres update.
const EDITABLE_ORDER_FIELDS = [
  'title', 'trade', 'location', 'description', 'urgency',
  'repair_ceiling', 'assessment_target', 'ground_rules', 'office_note',
] as const

function pickEditableFields(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of EDITABLE_ORDER_FIELDS) {
    if (key in patch) out[key] = patch[key]
  }
  return out
}

function dispatchDb() {
  const url = Deno.env.get('DISPATCH_AGENT_SUPABASE_URL')
  const key = Deno.env.get('DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return null
  return createClient(url, key)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405)
  }

  try {
    const body = await req.json().catch(() => null)
    const action = body?.action as Action | undefined
    const payload = body?.payload ?? {}

    if (!action || (!API_ACTIONS.has(action) && !DB_ACTIONS.has(action) && !INBOX_ACTIONS.has(action))) {
      return jsonResponse(
        { error: 'action must be one of "create_order", "call_technician", "update_order", "reassign_technician", "set_auto_dispatch", "cancel_order", "add_technician", "set_inbox_handled"' },
        400,
      )
    }

    // ---- Inbox actions: write straight to ai_dispatch_inbox (the incoming
    // call log), keyed by inboxId rather than orderId. ----
    if (INBOX_ACTIONS.has(action)) {
      if (!payload.inboxId) {
        return jsonResponse({ error: 'payload.inboxId is required' }, 400)
      }
      if (typeof payload.handled !== 'boolean') {
        return jsonResponse({ error: 'payload.handled must be a boolean' }, 400)
      }
      const db = dispatchDb()
      if (!db) {
        console.error('env_check failed', { has_url: false, has_key: false })
        return jsonResponse(
          { step: 'env_check', error: 'Missing DISPATCH_AGENT_SUPABASE_URL / DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY' },
          500,
        )
      }
      const { data, error } = await db
        .from('ai_dispatch_inbox')
        .update({ handled: payload.handled })
        .eq('id', payload.inboxId)
        .select('id, handled')
        .maybeSingle()

      if (error) {
        console.error('set_inbox_handled db update failed', error)
        return jsonResponse({ step: action, error: error.message }, 500)
      }
      if (!data) {
        return jsonResponse({ step: action, error: 'No inbox item found with that id' }, 404)
      }
      return jsonResponse({ ok: true, result: data })
    }

    // ---- Direct-DB actions: write straight to ai_dispatch_orders. ----
    if (DB_ACTIONS.has(action)) {
      if (!payload.orderId) {
        return jsonResponse({ error: 'payload.orderId is required' }, 400)
      }
      const db = dispatchDb()
      if (!db) {
        console.error('env_check failed', { has_url: false, has_key: false })
        return jsonResponse(
          { step: 'env_check', error: 'Missing DISPATCH_AGENT_SUPABASE_URL / DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY' },
          500,
        )
      }

      if (action === 'add_technician') {
        if (!payload.name) {
          return jsonResponse({ error: 'payload.name is required' }, 400)
        }
        const { data, error } = await db
          .from('ai_dispatch_technicians')
          .insert({
            order_id: payload.orderId,
            name: payload.name,
            company: payload.company ?? '',
            phone: payload.phone ?? null,
            email: payload.email ?? '',
            notes: payload.notes ?? '',
            source: 'Manually added',
            status: 'Sourced',
          })
          .select('id, name, company, phone, status')
          .single()

        if (error) {
          console.error('add_technician db insert failed', error)
          return jsonResponse({ step: action, error: error.message }, 500)
        }
        return jsonResponse({ ok: true, result: data })
      }

      let patch: Record<string, unknown>
      if (action === 'update_order') {
        patch = pickEditableFields(payload.patch ?? {})
        if (Object.keys(patch).length === 0) {
          return jsonResponse({ error: 'payload.patch has no editable fields' }, 400)
        }
      } else if (action === 'reassign_technician') {
        // technicianId may be null, to clear the assignment.
        patch = { assigned_technician_id: payload.technicianId ?? null }
      } else if (action === 'set_auto_dispatch') {
        if (typeof payload.autoDispatch !== 'boolean') {
          return jsonResponse({ error: 'payload.autoDispatch must be a boolean' }, 400)
        }
        patch = { auto_dispatch: payload.autoDispatch }
      } else {
        // cancel_order -- stop the scheduler from acting on it, and make
        // the terminal state visible in status too.
        patch = { auto_dispatch: false, status: 'Cancelled' }
      }

      const { data, error } = await db
        .from('ai_dispatch_orders')
        .update(patch)
        .eq('id', payload.orderId)
        .select('id, title, status, auto_dispatch, assigned_technician_id')
        .maybeSingle()

      if (error) {
        console.error(`${action} db update failed`, error)
        return jsonResponse({ step: action, error: error.message }, 500)
      }
      if (!data) {
        return jsonResponse({ step: action, error: 'No order found with that id' }, 404)
      }
      return jsonResponse({ ok: true, result: data })
    }

    // ---- API actions: log into Raley and forward to its real endpoint. ----
    const RALEY_ADMIN_PASSWORD = Deno.env.get('RALEY_ADMIN_PASSWORD')
    if (!RALEY_ADMIN_PASSWORD) {
      // Never logs the password itself, only whether it's set.
      console.error('env_check failed', { has_password: false })
      return jsonResponse({ step: 'env_check', error: 'Missing RALEY_ADMIN_PASSWORD' }, 500)
    }

    if (action === 'call_technician' && (!payload.orderId || !payload.technicianId)) {
      return jsonResponse({ error: 'payload.orderId and payload.technicianId are required' }, 400)
    }
    if (action === 'create_order' && (!payload.title || !payload.location)) {
      return jsonResponse({ error: 'payload.title and payload.location are required' }, 400)
    }

    // Step 1: log in to Raley with its own admin password to get a session.
    let loginRes: Response
    try {
      loginRes = await fetch(`${RALEY_BASE_URL}/api/admin?r=login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: RALEY_ADMIN_PASSWORD }),
      })
    } catch (err) {
      console.error('raley login request failed', errMsg(err))
      return jsonResponse({ step: 'login', error: `Couldn't reach Raley: ${errMsg(err)}` }, 502)
    }
    if (!loginRes.ok) {
      console.error('raley login rejected', { status: loginRes.status })
      return jsonResponse(
        { step: 'login', error: `Raley rejected the login (status ${loginRes.status}) -- check RALEY_ADMIN_PASSWORD is current` },
        502,
      )
    }

    const setCookies: string[] = typeof (loginRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (loginRes.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [loginRes.headers.get('set-cookie')].filter((c): c is string => !!c)
    if (!setCookies.length) {
      console.error('raley login had no set-cookie header')
      return jsonResponse({ step: 'login', error: 'Raley login succeeded but returned no session cookie' }, 502)
    }
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ')

    // Step 2: forward the actual action to Raley's real, already-tested endpoint.
    // createdByDispatcher isn't one of Raley's own order columns (it's not in
    // orders.js's FIELDS whitelist), so strip it before forwarding -- it's
    // applied afterward, directly, below.
    const target = action === 'create_order' ? '/api/orders' : '/api/calls-start'
    const { createdByDispatcher, ...forwardPayload } = payload as Record<string, unknown> & { createdByDispatcher?: string }
    let actionRes: Response
    try {
      actionRes = await fetch(`${RALEY_BASE_URL}${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify(forwardPayload),
      })
    } catch (err) {
      console.error(`raley ${action} request failed`, errMsg(err))
      return jsonResponse({ step: action, error: `Couldn't reach Raley: ${errMsg(err)}` }, 502)
    }

    const actionBody = await actionRes.json().catch(() => null)
    if (!actionRes.ok) {
      console.error(`raley ${action} failed`, { status: actionRes.status, body: actionBody })
      return jsonResponse(
        { step: action, error: actionBody?.error || `Raley returned ${actionRes.status}`, details: actionBody },
        actionRes.status < 500 ? actionRes.status : 500,
      )
    }

    // Tag who created this order, for the dispatcher-scoped view in
    // dispatch-agent-activity. Raley's own /api/orders has no column for
    // this (see the FIELDS whitelist in orders.js), so it's set with a
    // direct follow-up write using the same service-role credentials the
    // DB actions above already use. Best-effort: the order itself is
    // already created and real, so a failure here never fails the request
    // -- it would just leave that one order untagged for scoping purposes.
    if (action === 'create_order' && createdByDispatcher) {
      try {
        const db = dispatchDb()
        if (db) {
          const newId = (actionBody as { id?: string; order?: { id?: string }; data?: { id?: string } } | null)?.id
            ?? (actionBody as { order?: { id?: string } } | null)?.order?.id
            ?? (actionBody as { data?: { id?: string } } | null)?.data?.id
            ?? null
          if (newId) {
            await db.from('ai_dispatch_orders').update({ created_by_dispatcher: createdByDispatcher }).eq('id', newId)
          } else {
            // Raley's response didn't expose the new row's id in a shape we
            // recognize -- fall back to the most recent still-untagged order
            // matching exactly what was just submitted.
            const { data: recent } = await db
              .from('ai_dispatch_orders')
              .select('id, created_at')
              .eq('title', (forwardPayload as { title?: string }).title ?? '')
              .eq('location', (forwardPayload as { location?: string }).location ?? '')
              .is('created_by_dispatcher', null)
              .order('created_at', { ascending: false })
              .limit(1)
            const candidate = recent?.[0]
            if (candidate && Date.now() - new Date(candidate.created_at).getTime() < 30000) {
              await db.from('ai_dispatch_orders').update({ created_by_dispatcher: createdByDispatcher }).eq('id', candidate.id)
            }
          }
        }
      } catch (tagErr) {
        console.error('create_order: failed to tag created_by_dispatcher (non-fatal)', errMsg(tagErr))
      }
    }

    return jsonResponse({ ok: true, result: actionBody })
  } catch (err) {
    console.error('unhandled error', errMsg(err))
    return jsonResponse({ step: 'unhandled', error: errMsg(err) }, 500)
  }
})
