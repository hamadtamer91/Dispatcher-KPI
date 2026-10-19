import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { DispatchActivity } from '../lib/types'

// Live calls and incoming calls need to feel current without the dispatcher
// manually hitting Refresh, so this polls quietly in the background. Only
// the very first load shows the loading state -- later polls swap `data` in
// place so the page doesn't flicker every few seconds.
const POLL_MS = 8000

// Pass a dispatcherName to scope the whole activity feed to just that
// dispatcher's own orders (and only the calls/alerts/inbox/approvals tied
// to one of those orders) -- used for the dispatcher role's own Dispatch
// Agent tab. Omit it (or pass null/undefined) for the unscoped admin view.
export function useDispatchActivity(dispatcherName?: string | null) {
  const [data, setData] = useState<DispatchActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const isFirstLoad = useRef(true)

  const refetch = useCallback(async () => {
    if (isFirstLoad.current) setLoading(true)
    const { data: body, error: err } = await supabase.functions.invoke('dispatch-agent-activity', {
      body: { dispatcherName: dispatcherName ?? null },
    })
    if (err) {
      setError(err.message)
    } else {
      setData(body as DispatchActivity)
      setError('')
    }
    if (isFirstLoad.current) {
      setLoading(false)
      isFirstLoad.current = false
    }
  }, [dispatcherName])

  useEffect(() => {
    refetch()
    const id = setInterval(refetch, POLL_MS)
    return () => clearInterval(id)
  }, [refetch])

  return { data, loading, error, refetch }
}
