import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import type { CbreRateCardRow } from '../lib/types'

/** CBRE's trade/subtrade rate card for the active entity -- read-only lookup used to auto-fill a proposal's Technician/Helper rates. */
export function useCbreRateCard() {
  const { activeEntityId } = useEntityScope()
  const [rows, setRows] = useState<CbreRateCardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!activeEntityId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('cbre_rate_card')
      .select('*')
      .eq('entity_id', activeEntityId)
      .eq('active', true)
      .order('sort_order')
    setError(err?.message || null)
    setRows((data as CbreRateCardRow[]) ?? [])
    setLoading(false)
  }, [activeEntityId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { rows, loading, error, refresh }
}
