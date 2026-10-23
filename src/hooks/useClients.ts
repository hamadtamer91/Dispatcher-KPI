import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import type { Client } from '../lib/types'

/** The active entity's managed client catalog -- used for the Proposal's
 *  Client Name dropdown. Adding a new one is restricted to super_admin by
 *  RLS; this hook just surfaces whether that insert will be allowed so the
 *  UI can hide the "add" control for everyone else. */
export function useClients() {
  const { activeEntityId } = useEntityScope()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!activeEntityId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('clients')
      .select('*')
      .eq('entity_id', activeEntityId)
      .eq('active', true)
      .order('name')
    if (err) setError(err.message)
    else {
      setClients((data as Client[]) ?? [])
      setError(null)
    }
    setLoading(false)
  }, [activeEntityId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const addClient = useCallback(
    async (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const { data, error: err } = await supabase
        .from('clients')
        .insert({ name: trimmed, entity_id: activeEntityId })
        .select()
        .single()
      if (err) throw err
      await refresh()
      return data as Client
    },
    [refresh, activeEntityId],
  )

  return { clients, loading, error, refresh, addClient }
}
