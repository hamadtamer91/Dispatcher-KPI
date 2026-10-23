import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { LineItemKind, Proposal, ProposalLineItem, ProposalPhoto } from '../lib/types'

// "Breakdown" check result -- see supabase/functions/audit-proposal. Report
// -only: nothing here is ever auto-applied to the proposal.
export type BreakdownSeverity = 'high' | 'medium' | 'low'
export interface BreakdownFinding {
  severity: BreakdownSeverity
  category: string
  message: string
}
export interface BreakdownResult {
  findings: BreakdownFinding[]
  overall_assessment: string
  checked_at: string
}

/** A single proposal with its line items and photos, plus mutations for the editor page. */
export function useProposalDetail(id: string | undefined) {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [lineItems, setLineItems] = useState<ProposalLineItem[]>([])
  const [photos, setPhotos] = useState<ProposalPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [checkingBreakdown, setCheckingBreakdown] = useState(false)

  const refresh = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [{ data: p, error: pErr }, { data: li, error: liErr }, { data: ph, error: phErr }] = await Promise.all([
      supabase.from('proposals').select('*').eq('id', id).single(),
      supabase.from('proposal_line_items').select('*').eq('proposal_id', id).order('sort_order'),
      supabase.from('proposal_photos').select('*').eq('proposal_id', id).order('sort_order'),
    ])
    setError(pErr?.message ?? null)
    setProposal((p as Proposal) ?? null)
    setLineItems((li as ProposalLineItem[]) ?? [])
    setPhotos((ph as ProposalPhoto[]) ?? [])
    setLoading(false)
    // eslint-disable-next-line no-console
    if (liErr) console.error(liErr)
    // eslint-disable-next-line no-console
    if (phErr) console.error(phErr)
  }, [id])

  useEffect(() => {
    refresh()
  }, [refresh])

  const updateProposal = useCallback(
    async (patch: Partial<Proposal>) => {
      if (!id) return
      const { data, error: err } = await supabase.from('proposals').update(patch).eq('id', id).select().single()
      if (err) throw err
      setProposal(data as Proposal)
      return data as Proposal
    },
    [id],
  )

  const addLineItem = useCallback(
    async (item: { kind: LineItemKind; description: string; quantity: number; unit_cost: number; unit_price: number }) => {
      if (!id) return
      const { data, error: err } = await supabase
        .from('proposal_line_items')
        .insert({ proposal_id: id, ai_suggested: false, sort_order: lineItems.length, ...item })
        .select()
        .single()
      if (err) throw err
      await refresh()
      return data as ProposalLineItem
    },
    [id, lineItems.length, refresh],
  )

  const updateLineItem = useCallback(
    async (itemId: string, patch: Partial<ProposalLineItem>) => {
      const { error: err } = await supabase.from('proposal_line_items').update(patch).eq('id', itemId)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const deleteLineItem = useCallback(
    async (itemId: string) => {
      const { error: err } = await supabase.from('proposal_line_items').delete().eq('id', itemId)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const uploadPhoto = useCallback(
    async (file: File, caption?: string, sortOrderOverride?: number) => {
      if (!id) return
      const ext = file.name.split('.').pop() || 'jpg'
      const path = `${id}/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage.from('proposal-photos').upload(path, file)
      if (upErr) throw upErr
      const { data: userData } = await supabase.auth.getUser()
      const { error: insErr } = await supabase.from('proposal_photos').insert({
        proposal_id: id,
        storage_path: path,
        caption: caption ?? null,
        sort_order: sortOrderOverride ?? photos.length,
        uploaded_by: userData?.user?.id ?? null,
      })
      if (insErr) throw insErr
      await refresh()
    },
    [id, photos.length, refresh],
  )

  /** Uploads several photos at a time, one after another, each keeping its
   *  place after whatever's already there -- for the bulk "Add photos"
   *  picker. Stops at the first failure but reports how many made it in. */
  const uploadPhotos = useCallback(
    async (files: File[]) => {
      const baseOrder = photos.length
      let uploaded = 0
      for (let i = 0; i < files.length; i++) {
        await uploadPhoto(files[i], undefined, baseOrder + i)
        uploaded++
      }
      return uploaded
    },
    [photos.length, uploadPhoto],
  )

  const deletePhoto = useCallback(
    async (photo: ProposalPhoto) => {
      await supabase.storage.from('proposal-photos').remove([photo.storage_path])
      const { error: err } = await supabase.from('proposal_photos').delete().eq('id', photo.id)
      if (err) throw err
      await refresh()
    },
    [refresh],
  )

  const photoUrl = useCallback(async (path: string) => {
    const { data, error: err } = await supabase.storage.from('proposal-photos').createSignedUrl(path, 3600)
    if (err) throw err
    return data.signedUrl
  }, [])

  const generateDraft = useCallback(async () => {
    if (!id) return
    setGenerating(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.functions.invoke('generate-proposal', {
        body: { proposal_id: id },
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
      await refresh()
      return data
    } catch (e) {
      setError((e as Error).message)
      throw e
    } finally {
      setGenerating(false)
    }
  }, [id, refresh])

  // Runs the read-only "Breakdown" audit (sales tax, EMG/rate-sheet, equal
  // -hours, narrative-vs-line-items scope) against this proposal exactly as
  // currently saved. Never writes anything -- the dispatcher applies any fix
  // by hand in the editor above.
  const runBreakdownCheck = useCallback(async (): Promise<BreakdownResult> => {
    if (!id) throw new Error('No proposal to check')
    setCheckingBreakdown(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.functions.invoke('audit-proposal', {
        body: { proposal_id: id },
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
      return data as BreakdownResult
    } catch (e) {
      setError((e as Error).message)
      throw e
    } finally {
      setCheckingBreakdown(false)
    }
  }, [id])

  return {
    proposal,
    lineItems,
    photos,
    loading,
    error,
    generating,
    checkingBreakdown,
    refresh,
    updateProposal,
    addLineItem,
    updateLineItem,
    deleteLineItem,
    uploadPhoto,
    uploadPhotos,
    deletePhoto,
    photoUrl,
    generateDraft,
    runBreakdownCheck,
  }
}
