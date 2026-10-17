// Write bridge into Raley (nexafix-voice-agent), the SEPARATE AI dispatch
// agent app -- a different system from this project's own work_orders/
// proposals tables (see README, and supabase/functions/dispatch-agent-activity
// for the read-only counterpart to this function).
//
// Raley's own API (POST /api/orders, POST /api/calls-start) already does the
// real work -- validation, auto-dispatch kickoff, and placing the actual
// Vapi phone call. This function does not reimplement any of that; it only
// logs in with Raley's own admin password (RALEY_ADMIN_PASSWORD, set as an
// Edge Function secret here, never shipped to the browser) and forwards the
// dashboard's request to Raley's real endpoint, so "New Work Order" and
// "Call technician now" in this dashboard behave exactly as if they were
// done from Raley's own app.
//
//   POST { action: "create_order", payload: {...order fields} }
//   POST { action: "call_technician", payload: { orderId, technicianId, purpose? } }

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

type Action = 'create_order' | 'call_technician'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405)
  }

  try {
    const RALEY_ADMIN_PASSWORD = Deno.env.get('RALEY_ADMIN_PASSWORD')
    if (!RALEY_ADMIN_PASSWORD) {
      // Never logs the password itself, only whether it's set.
      console.error('env_check failed', { has_password: false })
      return jsonResponse({ step: 'env_check', error: 'Missing RALEY_ADMIN_PASSWORD' }, 500)
    }

    const body = await req.json().catch(() => null)
    const action = body?.action as Action | undefined
    const payload = body?.payload ?? {}

    if (action !== 'create_order' && action !== 'call_technician') {
      return jsonResponse({ error: 'action must be "create_order" or "call_technician"' }, 400)
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
    const target = action === 'create_order' ? '/api/orders' : '/api/calls-start'
    let actionRes: Response
    try {
      actionRes = await fetch(`${RALEY_BASE_URL}${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify(payload),
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

    return jsonResponse({ ok: true, result: actionBody })
  } catch (err) {
    console.error('unhandled error', errMsg(err))
    return jsonResponse({ step: 'unhandled', error: errMsg(err) }, 500)
  }
})
