import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import type { Proposal } from '../lib/types'

/** List of proposals visible to the current user, scoped to the active
 *  entity (RLS further restricts dispatchers to just their own within it). */
export function useProposals() {
  const { activeEntityId } = useEntityScope()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!activeEntityId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('proposals')
      .select('*')
      .eq('entity_id', activeEntityId)
      .order('updated_at', { ascending: false })
    if (err) setError(err.message)
    else {
      setProposals((data as Proposal[]) ?? [])
      setError(null)
    }
    setLoading(false)
  }, [activeEntityId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createProposal = useCallback(
    async (wo: string, dispatcherName: string | null) => {
      const { data, error: err } = await supabase
        .from('proposals')
        .insert({ wo, dispatcher_name: dispatcherName, entity_id: activeEntityId })
        .select()
        .single()
      if (err) throw err
      await refresh()
      return data as Proposal
    },
    [refresh, activeEntityId],
  )

  const deleteProposal = useCallback(
    async (id: string) => {
      const { error: err } = await supabase.from('proposals').delete().eq('id', id)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  return { proposals, loading, error, refresh, createProposal, deleteProposal }
}
