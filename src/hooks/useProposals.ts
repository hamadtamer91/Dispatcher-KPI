import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Proposal } from '../lib/types'

/** List of proposals visible to the current user (RLS scopes this automatically:
 *  dispatchers see only their own, super_admin/data_entry see all). */
export function useProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('proposals')
      .select('*')
      .order('updated_at', { ascending: false })
    if (err) setError(err.message)
    else {
      setProposals((data as Proposal[]) ?? [])
      setError(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createProposal = useCallback(
    async (wo: string, dispatcherName: string | null) => {
      const { data, error: err } = await supabase
        .from('proposals')
        .insert({ wo, dispatcher_name: dispatcherName })
        .select()
        .single()
      if (err) throw err
      await refresh()
      return data as Proposal
    },
    [refresh],
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
