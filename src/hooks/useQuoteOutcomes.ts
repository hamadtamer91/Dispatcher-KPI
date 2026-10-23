import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import type { QuoteOutcome } from '../lib/types'

export type NewQuoteOutcome = Omit<QuoteOutcome, 'id' | 'created_by' | 'created_at' | 'updated_at'>

/** Labeled quote outcomes (approved/rejected/revision-requested) -- shared
 *  across the active entity's whole team, same as that entity's labor rates
 *  and parts catalog, since the AI reads all of it (not just the current
 *  user's) when pricing a new proposal for that entity. */
export function useQuoteOutcomes() {
  const { activeEntityId } = useEntityScope()
  const [outcomes, setOutcomes] = useState<QuoteOutcome[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!activeEntityId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('quote_outcomes')
      .select('*')
      .eq('entity_id', activeEntityId)
      .order('created_at', { ascending: false })
    if (err) setError(err.message)
    else {
      setOutcomes((data as QuoteOutcome[]) ?? [])
      setError(null)
    }
    setLoading(false)
  }, [activeEntityId])

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
        .insert({ ...row, created_by: user?.id ?? null, entity_id: activeEntityId })
        .select()
        .single()
      if (err) throw err
      await refresh()
      return data as QuoteOutcome
    },
    [refresh, activeEntityId],
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

  /** Pastes a raw old quote/proposal breakdown (whatever format it's in)
   *  through the AI so the dispatcher doesn't have to retype the total by
   *  hand -- returns whatever fields it could confidently pull out
   *  (total_price, and total_cost/markup_pct/trade only when the text
   *  actually supports them). Caller decides how to merge these into the
   *  form; nothing is saved here. */
  const parseQuoteText = useCallback(async (rawText: string) => {
    const { data, error: err } = await supabase.functions.invoke('parse-quote-text', {
      body: { raw_text: rawText },
    })
    if (err) {
      let message = err.message
      try {
        const ctx = (err as unknown as { context?: Response }).context
        if (ctx) {
          const body = await ctx.clone().json()
          if (body?.error) message = body.error
        }
      } catch {
        // fall back to err.message
      }
      throw new Error(message)
    }
    if (data?.error) throw new Error(data.error)
    return data.parsed as {
      total_price: number | null
      total_cost?: number | null
      markup_pct?: number | null
      trade?: string | null
    }
  }, [])

  return {
    outcomes,
    loading,
    error,
    refresh,
    addOutcome,
    updateOutcome,
    deleteOutcome,
    recordProposalOutcome,
    parseQuoteText,
  }
}
