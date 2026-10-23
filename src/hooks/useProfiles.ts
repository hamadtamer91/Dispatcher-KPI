import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

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

  const deleteProfile = useCallback(async (id: string) => {
    await supabase.from('profiles').delete().eq('id', id)
    refetch()
  }, [refetch])

  return { profiles, loading, refetch, updateScorecard, updateEntity, deleteProfile }
}
