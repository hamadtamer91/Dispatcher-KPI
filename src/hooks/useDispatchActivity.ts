import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { DispatchActivity } from '../lib/types'

export function useDispatchActivity() {
  const [data, setData] = useState<DispatchActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refetch = useCallback(async () => {
    setLoading(true)
    const { data: body, error: err } = await supabase.functions.invoke('dispatch-agent-activity')
    if (err) {
      setError(err.message)
    } else {
      setData(body as DispatchActivity)
      setError('')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { data, loading, error, refetch }
}
