import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import type { WorkOrder } from '../lib/types'

const NUMERIC_FIELDS = new Set(['nte', 'cost', 'profit_pct', 'assessment_fee', 'technicians_count'])
const BOOL_FIELDS = new Set(['nte_approved', 'first_visit_complete', 'is_assessment_visit', 'tech_complaint'])

function normalize(input: Partial<WorkOrder>): Partial<WorkOrder> {
  const out: Record<string, unknown> = { ...input }
  for (const key of Object.keys(out)) {
    const val = out[key]
    if (val === '') {
      out[key] = null
      continue
    }
    if (NUMERIC_FIELDS.has(key) && typeof val === 'string') {
      const n = Number(val)
      out[key] = Number.isNaN(n) ? null : n
    }
    if (BOOL_FIELDS.has(key) && typeof val === 'string') {
      out[key] = val.toLowerCase() === 'true' || val.toLowerCase() === 'yes'
    }
  }
  return out as Partial<WorkOrder>
}

export function useWorkOrders() {
  const { activeEntityId } = useEntityScope()
  const [wos, setWos] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refetch = useCallback(async () => {
    if (!activeEntityId) return
    const { data, error: err } = await supabase
      .from('work_orders')
      .select('*')
      .eq('entity_id', activeEntityId)
      .order('wo_date', { ascending: false })
    if (err) {
      setError(err.message)
    } else {
      setWos((data ?? []) as WorkOrder[])
      setError('')
    }
    setLoading(false)
  }, [activeEntityId])

  useEffect(() => {
    refetch()
    const channel = supabase
      .channel('work_orders_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, () => refetch())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [refetch])

  const saveWO = useCallback(async (input: Partial<WorkOrder>, isNew: boolean) => {
    const payload = normalize(input)
    if (isNew) {
      const { error: err } = await supabase.from('work_orders').insert({ ...payload, entity_id: activeEntityId })
      if (err) throw err
    } else {
      const { wo, ...rest } = payload
      const { error: err } = await supabase.from('work_orders').update(rest).eq('wo', wo)
      if (err) throw err
    }
  }, [activeEntityId])

  const deleteWO = useCallback(async (wo: string) => {
    const { error: err } = await supabase.from('work_orders').delete().eq('wo', wo)
    if (err) throw err
  }, [])

  const importWOs = useCallback(async (rows: Partial<WorkOrder>[]) => {
    const payload = rows.map(normalize).filter((r) => r.wo).map((r) => ({ ...r, entity_id: activeEntityId }))
    const { data, error: err } = await supabase.from('work_orders').upsert(payload, { onConflict: 'wo' }).select()
    if (err) throw err
    return data
  }, [activeEntityId])

  return { wos, loading, error, refetch, saveWO, deleteWO, importWOs }
}
