import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Every role a login can have. 'data_entry' is the original catch-all office
// role -- still accepted here so a Super Admin can recreate one, but the
// Manage Users page no longer offers it.
const ALL_ROLES = ['super_admin', 'admin', 'account_manager', 'team_leader', 'dispatcher', 'data_entry']
// The only roles an Admin may create, and only inside their own entity.
const ADMIN_CAN_CREATE = ['account_manager', 'team_leader', 'dispatcher']

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

/** Creates a new login (auth user + profile). Allowed callers:
 *   - a Super Admin: any role, any entity
 *   - an Admin: Account Manager / Team Leader / Dispatcher, in their own entity only
 *  Checked here against the caller's own profile, since creating an auth user
 *  needs the service-role key, which the frontend never holds. The very first
 *  login ever created (no profiles exist yet) needs no caller. */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const body = await req.json()
    const { email, password, role, displayName, dispatcherName, entityId, teamLeaderId } = body ?? {}

    if (!email || !password || !role || !displayName) {
      return json({ error: 'email, password, role, and displayName are required.' }, 400)
    }
    if (!ALL_ROLES.includes(role)) {
      return json({ error: `Invalid role: ${role}` }, 400)
    }
    if (!entityId) {
      return json({ error: 'entityId is required -- pick which entity this user works for.' }, 400)
    }

    const { count, error: countErr } = await admin.from('profiles').select('*', { count: 'exact', head: true })
    if (countErr) {
      return json({ error: `Could not check existing profiles: ${countErr.message}` }, 500)
    }

    if ((count ?? 0) > 0) {
      const authHeader = req.headers.get('Authorization') || ''
      const token = authHeader.replace(/^Bearer\s+/i, '')
      if (!token) {
        return json({ error: 'Missing authorization token.' }, 401)
      }
      const { data: callerData, error: callerErr } = await admin.auth.getUser(token)
      if (callerErr || !callerData?.user) {
        return json({ error: 'Invalid or expired session.' }, 401)
      }
      const { data: callerProfile, error: profileErr } = await admin
        .from('profiles')
        .select('role, entity_id')
        .eq('id', callerData.user.id)
        .single()
      if (profileErr || !callerProfile) {
        return json({ error: 'Only a Super Admin or Admin can create new logins.' }, 403)
      }
      if (callerProfile.role === 'admin') {
        if (!ADMIN_CAN_CREATE.includes(role)) {
          return json({ error: 'An Admin can only create Account Manager, Team Leader and Dispatcher logins.' }, 403)
        }
        if (entityId !== callerProfile.entity_id) {
          return json({ error: 'An Admin can only create logins for their own entity.' }, 403)
        }
      } else if (callerProfile.role !== 'super_admin') {
        return json({ error: 'Only a Super Admin or Admin can create new logins.' }, 403)
      }
    }

    const { data: entityRow, error: entityErr } = await admin
      .from('entities')
      .select('id')
      .eq('id', entityId)
      .eq('active', true)
      .maybeSingle()
    if (entityErr) {
      return json({ error: `Could not verify entity: ${entityErr.message}` }, 500)
    }
    if (!entityRow) {
      return json({ error: 'Unknown or inactive entity.' }, 400)
    }

    // A dispatcher can be put on a Team Leader's team at creation. The leader
    // must be a Team Leader account in the same entity (the database enforces
    // this too; checking here gives a clear message before any login exists).
    let teamLeader: string | null = null
    if (role === 'dispatcher' && teamLeaderId) {
      const { data: leaderRow, error: leaderErr } = await admin
        .from('profiles')
        .select('id')
        .eq('id', teamLeaderId)
        .eq('role', 'team_leader')
        .eq('entity_id', entityId)
        .maybeSingle()
      if (leaderErr) {
        return json({ error: `Could not verify team leader: ${leaderErr.message}` }, 500)
      }
      if (!leaderRow) {
        return json({ error: 'The team leader must be a Team Leader account in the same entity.' }, 400)
      }
      teamLeader = leaderRow.id
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createErr || !created?.user) {
      return json({ error: createErr?.message || 'Failed to create user.' }, 400)
    }

    const { error: insertErr } = await admin.from('profiles').insert({
      id: created.user.id,
      display_name: displayName,
      role,
      dispatcher_name: role === 'dispatcher' ? (dispatcherName || null) : null,
      team_leader_id: teamLeader,
      entity_id: entityId,
    })
    if (insertErr) {
      await admin.auth.admin.deleteUser(created.user.id)
      return json({ error: `Failed to create profile: ${insertErr.message}` }, 500)
    }

    return json({ success: true, id: created.user.id })
  } catch (err) {
    return json({ error: errMsg(err) }, 500)
  }
})
