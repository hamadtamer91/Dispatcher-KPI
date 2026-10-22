import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { QuoteOutcome } from '../lib/types'

export type NewQuoteOutcome = Omit<QuoteOutcome, 'id' | 'created_by' | 'created_at' | 'updated_at'>

/** Labeled quote outcomes (approved/rejected/revision-requested) -- shared
 *  across the whole team, same as the labor rates and parts catalog, since
 *  the AI reads all of it (not just the current user's) when pricing a new
 *  proposal. */
export function useQuoteOutcomes() {
  const [outcomes, setOutcomes] = useState<QuoteOutcome[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('quote_outcomes')
      .select('*')
      .order('created_at', { ascending: false })
    if (err) setError(err.message)
    else {
      setOutcomes((data as QuoteOutcome[]) ?? [])
      setError(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const addOutcome = useCallback(
    async (row: NewQuoteOutcome) => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const { data, error: err } = await supabase
        .from('quote_outcomes')
        .insert({ ...row, created_by: user?.id ?? null })
        .select()
        .single()
      if (err) throw err
      await refresh()
      return data as QuoteOutcome
    },
    [refresh],
  )

  const updateOutcome = useCallback(
    async (id: string, patch: Partial<NewQuoteOutcome>) => {
      const { error: err } = await supabase.from('quote_outcomes').update(patch).eq('id', id)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const deleteOutcome = useCallback(
    async (id: string) => {
      const { error: err } = await supabase.from('quote_outcomes').delete().eq('id', id)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  /** Upsert the outcome tied to a specific in-app proposal (one outcome per
   *  proposal) -- used by the "record client response" widget on the
   *  Proposal Detail page so a proposal's result doesn't need re-entering
   *  here by hand. */
  const recordProposalOutcome = useCallback(
    async (proposalId: string, row: Omit<NewQuoteOutcome, 'proposal_id'>) => {
      const existing = outcomes.find((o) => o.proposal_id === proposalId)
      if (existing) {
        await updateOutcome(existing.id, row)
      } else {
        await addOutcome({ ...row, proposal_id: proposalId })
      }
    },
    [outcomes, addOutcome, updateOutcome],
  )

  return { outcomes, loading, error, refresh, addOutcome, updateOutcome, deleteOutcome, recordProposalOutcome }
}
