import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (profileErr) {
      setError('Signed in, but no profile record exists for this account yet. Ask a Super Admin to create one.')
      setProfile(null)
    } else {
      setProfile(data as Profile)
      setError('')
    }
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) {
        loadProfile(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      if (newSession) {
        loadProfile(newSession.user.id)
      } else {
        setProfile(null)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [loadProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    setError('')
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password })
    if (signInErr) {
      setError(signInErr.message)
      return false
    }
    return true
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  return { session, profile, loading, error, signIn, signOut, refetchProfile: () => session && loadProfile(session.user.id) }
}
