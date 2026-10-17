import { useCallback, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { DispatchOrderPatch, NewDispatchOrder } from '../lib/types'

// Write actions against Raley, the separate AI dispatch agent, proxied
// through the raley-actions edge function (which logs into Raley's own
// admin API and forwards the request -- see that function's header comment).
// Both calls can fail server-side with a structured { step, error } body;
// surface that message rather than a generic "request failed".

async function extractError(err: { message: string }): Promise<string> {
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
  return message
}

export function useRaleyActions() {
  const [busy, setBusy] = useState(false)

  const createOrder = useCallback(async (payload: NewDispatchOrder) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('raley-actions', {
        body: { action: 'create_order', payload },
      })
      if (error) throw new Error(await extractError(error))
      if (data?.error) throw new Error(data.error)
      return data
    } finally {
      setBusy(false)
    }
  }, [])

  const callTechnician = useCallback(async (orderId: string, technicianId: string, purpose?: string) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('raley-actions', {
        body: { action: 'call_technician', payload: { orderId, technicianId, purpose } },
      })
      if (error) throw new Error(await extractError(error))
      if (data?.error) throw new Error(data.error)
      return data
    } finally {
      setBusy(false)
    }
  }, [])

  // The four actions below write straight to Raley's ai_dispatch_orders row
  // (see raley-actions' header comment for why that's safe) rather than
  // going through Raley's own API, since Raley has no HTTP endpoint for
  // editing an existing order.

  const updateOrder = useCallback(async (orderId: string, patch: DispatchOrderPatch) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('raley-actions', {
        body: { action: 'update_order', payload: { orderId, patch } },
      })
      if (error) throw new Error(await extractError(error))
      if (data?.error) throw new Error(data.error)
      return data
    } finally {
      setBusy(false)
    }
  }, [])

  const reassignTechnician = useCallback(async (orderId: string, technicianId: string | null) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('raley-actions', {
        body: { action: 'reassign_technician', payload: { orderId, technicianId } },
      })
      if (error) throw new Error(await extractError(error))
      if (data?.error) throw new Error(data.error)
      return data
    } finally {
      setBusy(false)
    }
  }, [])

  const setAutoDispatch = useCallback(async (orderId: string, autoDispatch: boolean) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('raley-actions', {
        body: { action: 'set_auto_dispatch', payload: { orderId, autoDispatch } },
      })
      if (error) throw new Error(await extractError(error))
      if (data?.error) throw new Error(data.error)
      return data
    } finally {
      setBusy(false)
    }
  }, [])

  const cancelOrder = useCallback(async (orderId: string) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('raley-actions', {
        body: { action: 'cancel_order', payload: { orderId } },
      })
      if (error) throw new Error(await extractError(error))
      if (data?.error) throw new Error(data.error)
      return data
    } finally {
      setBusy(false)
    }
  }, [])

  return { createOrder, callTechnician, updateOrder, reassignTechnician, setAutoDispatch, cancelOrder, busy }
}
