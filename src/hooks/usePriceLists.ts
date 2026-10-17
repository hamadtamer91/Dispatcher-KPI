import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { LaborRate, PartItem } from '../lib/types'

/** Labor rates + parts catalog, editable by super_admin, data_entry, and dispatcher. */
export function usePriceLists() {
  const [laborRates, setLaborRates] = useState<LaborRate[]>([])
  const [parts, setParts] = useState<PartItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [{ data: lr, error: lrErr }, { data: pp, error: ppErr }] = await Promise.all([
      supabase.from('labor_rates').select('*').order('role_name'),
      supabase.from('parts_price_list').select('*').order('name'),
    ])
    setError(lrErr?.message || ppErr?.message || null)
    setLaborRates((lr as LaborRate[]) ?? [])
    setParts((pp as PartItem[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const saveLaborRate = useCallback(
    async (rate: Partial<LaborRate>) => {
      const { error: err } = rate.id
        ? await supabase.from('labor_rates').update(rate).eq('id', rate.id)
        : await supabase.from('labor_rates').insert(rate)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const deleteLaborRate = useCallback(
    async (id: string) => {
      const { error: err } = await supabase.from('labor_rates').delete().eq('id', id)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const savePart = useCallback(
    async (part: Partial<PartItem>) => {
      const { error: err } = part.id
        ? await supabase.from('parts_price_list').update(part).eq('id', part.id)
        : await supabase.from('parts_price_list').insert(part)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const deletePart = useCallback(
    async (id: string) => {
      const { error: err } = await supabase.from('parts_price_list').delete().eq('id', id)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  return { laborRates, parts, loading, error, refresh, saveLaborRate, deleteLaborRate, savePart, deletePart }
}
