import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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

/** Lets a Super Admin set a new password for another user's login (the
 *  "Manage Users" page's password-reset button). Only a Super Admin may
 *  call this -- checked here against the caller's own profile, since the
 *  password itself can only be set with the service-role key, which the
 *  frontend never holds. */
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

    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      return json({ error: 'Missing authorization token.' }, 401)
    }
    const { data: callerData, error: callerErr } = await admin.auth.getUser(token)
    if (callerErr || !callerData?.user) {
      return json({ error: 'Invalid or expired session.' }, 401)
    }
    const { data: callerProfile, error: callerProfileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', callerData.user.id)
      .single()
    if (callerProfileErr || callerProfile?.role !== 'super_admin') {
      return json({ error: 'Only a Super Admin can change another user\'s password.' }, 403)
    }

    const body = await req.json()
    const { userId, newPassword } = body ?? {}

    if (!userId || typeof userId !== 'string') {
      return json({ error: 'userId is required.' }, 400)
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return json({ error: 'newPassword must be at least 8 characters.' }, 400)
    }

    const { data: targetProfile, error: targetErr } = await admin
      .from('profiles')
      .select('id, display_name')
      .eq('id', userId)
      .maybeSingle()
    if (targetErr) {
      return json({ error: `Could not verify user: ${targetErr.message}` }, 500)
    }
    if (!targetProfile) {
      return json({ error: 'No login found for that user.' }, 404)
    }

    const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password: newPassword })
    if (updateErr) {
      return json({ error: updateErr.message || 'Failed to update password.' }, 400)
    }

    return json({ success: true })
  } catch (err) {
    return json({ error: errMsg(err) }, 500)
  }
})
