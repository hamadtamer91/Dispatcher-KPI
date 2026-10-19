import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export interface LiveCallCount {
  total: number
  incoming: number
  outgoing: number
}

const EMPTY: LiveCallCount = { total: 0, incoming: 0, outgoing: 0 }

// A lightweight, always-unscoped poll just for the sidebar badge -- "how
// many calls are live right now, and which direction" is operational
// awareness every dispatcher using the dashboard should see, independent of
// whose orders they are and independent of whether the Dispatch Agent tab
// itself is even open. Deliberately separate from useDispatchActivity
// (which the page itself uses, possibly scoped to one dispatcher) rather
// than lifting that heavier feed up to App -- this only needs a count.
const POLL_MS = 12000

export function useLiveCallCount(enabled: boolean = true) {
  const [count, setCount] = useState<LiveCallCount>(EMPTY)

  useEffect(() => {
    if (!enabled) {
      setCount(EMPTY)
      return
    }
    let cancelled = false
    const poll = async () => {
      const { data } = await supabase.functions.invoke('dispatch-agent-activity', {
        body: { dispatcherName: null },
      })
      if (cancelled) return
      const liveCalls = (data?.live_calls ?? []) as { direction?: 'inbound' | 'outbound' }[]
      const incoming = liveCalls.filter((c) => c.direction === 'inbound').length
      const outgoing = liveCalls.filter((c) => c.direction === 'outbound').length
      setCount({ total: liveCalls.length, incoming, outgoing })
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [enabled])

  return count
}
