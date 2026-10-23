import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Entity } from '../lib/types'

/** The business entities this app serves (Global Maintenance Network, Nexa Fix, etc). Read-only lookup used for entity pickers. */
export function useEntities() {
  const [entities, setEntities] = useState<Entity[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    const { data, error } = await supabase.from('entities').select('*').eq('active', true).order('name')
    if (!error) setEntities((data ?? []) as Entity[])
    setLoading(false)
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { entities, loading, refetch }
}
