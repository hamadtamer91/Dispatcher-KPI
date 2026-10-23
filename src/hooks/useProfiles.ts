import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Profile, Role } from '../lib/types'

export function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    const { data, error } = await supabase.from('profiles').select('*').order('display_name')
    if (!error) setProfiles((data ?? []) as Profile[])
    setLoading(false)
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  const updateScorecard = useCallback(async (id: string, app_ivr: number, system_usage: number) => {
    await supabase.from('profiles').update({ app_ivr, system_usage }).eq('id', id)
    refetch()
  }, [refetch])

  const updateEntity = useCallback(async (id: string, entity_id: string) => {
    await supabase.from('profiles').update({ entity_id }).eq('id', id)
    refetch()
  }, [refetch])

  const updateRole = useCallback(async (id: string, role: Role) => {
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id)
    if (error) throw error
    refetch()
  }, [refetch])

  const updateDispatcherName = useCallback(async (id: string, dispatcher_name: string) => {
    await supabase.from('profiles').update({ dispatcher_name: dispatcher_name || null }).eq('id', id)
    refetch()
  }, [refetch])

  const deleteProfile = useCallback(async (id: string) => {
    await supabase.from('profiles').delete().eq('id', id)
    refetch()
  }, [refetch])

  return { profiles, loading, refetch, updateScorecard, updateEntity, updateRole, updateDispatcherName, deleteProfile }
}
