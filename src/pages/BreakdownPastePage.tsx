import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ClipboardCheck, Loader2, Copy, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { useClients } from '../hooks/useClients'
import { usePriceLists } from '../hooks/usePriceLists'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { PROPOSAL_PRIORITY_OPTIONS } from '../lib/types'
import type { ProposalPriority } from '../lib/types'
import { Badge, Button, PageHeader, Panel } from '../components/ui'
import type { BadgeVariant } from '../components/ui'

type Severity = 'high' | 'medium' | 'low'
interface CorrectedLineItem {
  kind: 'labor' | 'part' | 'other'
  description: string
  role_name?: string
  quantity: number
  unit_price: number
  changed: boolean
  note: string | null
}
interface ScopeFinding {
  severity: Severity
  category: string
  message: string
}
interface AuditTextResult {
  narrative_scope: string
  narrative_findings: string
  narrative_recommendation: string
  corrected_line_items: CorrectedLineItem[]
  fixes_applied: { category: string; message: string }[]
  scope_findings: ScopeFinding[]
  subtotal_before: number
  subtotal_after: number
  overall_assessment: string
  ai_learning?: { scope_label: string; outcomes_considered: number }
  checked_at: string
}

const SEVERITY_VARIANT: Record<Severity, BadgeVariant> = { high: 'danger', medium: 'warn', low: 'neutral' }
const CATEGORY_LABELS: Record<string, string> = {
  nte: 'NTE',
  scope_mismatch: 'Scope vs. Line Items',
  parts_pricing: 'Parts vs. Price List',
  pricing_risk: 'Pricing vs. History',
  other: 'Other',
}

/** The "paste it in" sibling of the Breakdown picker -- for a proposal that
 *  was never entered into this app. The dispatcher pastes the narrative +
 *  pricing breakdown as text; the AI parses it, then the SAME deterministic
 *  GMN rules used elsewhere (sales tax, EMG/normal rate sheet, equal hours)
 *  are actually applied to produce a corrected breakdown -- not just a list
 *  of flags, since there's no saved proposal to go edit by hand. A
 *  narrative-vs-line-items scope mismatch (repair vs. replace, etc.) is
 *  still only flagged with a suggested fix -- that needs a human call.
 *  Nothing here is saved anywhere. */
export function BreakdownPastePage() {
  const navigate = useNavigate()
  const { activeEntityId, switchableEntities } = useEntityScope()
  const { clients } = useClients()
  const { laborRates } = usePriceLists()
  const { wos } = useWorkOrders()

  const tradeOptions = useMemo(() => {
    const names = laborRates
      .map((r) => r.role_name.replace(/\s*\(EMG\)$/i, '').trim())
      .filter((n) => n.toLowerCase() !== 'helper')
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
  }, [laborRates])

  const [wo, setWo] = useState('')
  const [clientName, setClientName] = useState('')
  const [tradeName, setTradeName] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [priority, setPriority] = useState<ProposalPriority | ''>('')
  const [nte, setNte] = useState('')
  const [proposalText, setProposalText] = useState('')
  const [autoFilledWo, setAutoFilledWo] = useState('')
  const [matchedEntityId, setMatchedEntityId] = useState<string | null>(null)

  // As soon as the typed WO# matches a real work order, pull its
  // client/trade/city/state/NTE straight in -- those are the authoritative
  // values dispatch already has, so there's no reason to retype them. Only
  // fields the work order actually has get overwritten; anything the
  // dispatcher already typed for a field the WO leaves blank is left
  // alone. Every field stays editable afterward.
  //
  // This looks the WO# up directly (not through the entity-scoped `wos`
  // list above, which only has the currently active entity's work orders)
  // so it finds the WO -- and its OWN entity -- no matter which entity the
  // switcher happens to be on. That entity is what gets checked against
  // below (price list, GMN rules), not whatever the switcher shows.
  useEffect(() => {
    const trimmed = wo.trim()
    if (!trimmed) {
      setAutoFilledWo('')
      setMatchedEntityId(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from('work_orders')
        .select('wo, client, trade, city, state, nte, entity_id')
        .ilike('wo', trimmed)
        .limit(1)
        .maybeSingle()
      if (cancelled || !data) return
      if (data.client) setClientName(data.client)
      if (data.trade) setTradeName(data.trade)
      if (data.city) setCity(data.city)
      if (data.state) setState(data.state)
      if (data.nte != null) setNte(String(data.nte))
      setAutoFilledWo(data.wo)
      setMatchedEntityId(data.entity_id ?? null)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [wo])

  const matchedEntityName = useMemo(
    () => (matchedEntityId ? switchableEntities.find((e) => e.id === matchedEntityId)?.name : undefined),
    [matchedEntityId, switchableEntities],
  )

  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AuditTextResult | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCheck = async () => {
    if (!proposalText.trim()) {
      setError('Paste the proposal text first.')
      return
    }
    setChecking(true)
    setError('')
    setResult(null)
    setCopied(false)
    try {
      const { data, error: err } = await supabase.functions.invoke('audit-proposal-text', {
        body: {
          entity_id: matchedEntityId ?? activeEntityId,
          wo: wo.trim() || null,
          client_name: clientName.trim() || null,
          trade_name: tradeName.trim() || null,
          city: city.trim() || null,
          state: state.trim() || null,
          priority: priority || null,
          nte: nte.trim() ? Number(nte) : null,
          proposal_text: proposalText,
        },
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
      setResult(data as AuditTextResult)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const copyText = () => {
    if (!result) return
    const lines: string[] = []
    if (result.narrative_scope) lines.push(result.narrative_scope, '')
    if (result.narrative_findings) lines.push('Findings:', result.narrative_findings, '')
    if (result.narrative_recommendation) lines.push('Recommendation:', result.narrative_recommendation, '')
    lines.push('Breakdown:')
    for (const li of result.corrected_line_items) {
      lines.push(`- ${li.description} -- qty ${li.quantity} x $${li.unit_price.toFixed(2)} = $${(li.quantity * li.unit_price).toFixed(2)}`)
    }
    lines.push('', `Total: $${result.subtotal_after.toFixed(2)}`)
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Breakdown: Paste a Proposal"
        description="Paste a proposal's narrative and pricing breakdown as text. The AI will check it and fix anything it can (sales tax, EMG/normal rates, equal hours) -- scope mismatches between the narrative and the line items are flagged for you to decide, never changed automatically. Nothing here is saved."
        actions={
          <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate('/breakdown')}>
            Back
          </Button>
        }
      />

      <Panel className="p-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-sm font-bold text-ink">Work Order #</label>
            <input
              type="text"
              list="paste-wos"
              value={wo}
              onChange={(e) => setWo(e.target.value)}
              placeholder="WO #"
              className="field mt-1 w-full"
            />
            <datalist id="paste-wos">
              {wos.map((w) => (
                <option key={w.wo} value={w.wo} />
              ))}
            </datalist>
            {autoFilledWo && (
              <p className="text-xs text-good mt-1">
                Found WO {autoFilledWo}{matchedEntityName ? ` (${matchedEntityName})` : ''} -- client/trade/city/state/NTE filled in below. Edit any field if it's wrong.
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Client</label>
            <input
              type="text"
              list="paste-clients"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="e.g. O'Reilly"
              className="field mt-1 w-full"
            />
            <datalist id="paste-clients">
              {clients.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Trade</label>
            <input
              type="text"
              list="paste-trades"
              value={tradeName}
              onChange={(e) => setTradeName(e.target.value)}
              placeholder="e.g. Plumber"
              className="field mt-1 w-full"
            />
            <datalist id="paste-trades">
              {tradeOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">City</label>
            <input type="text" value={city} onChange={(e) => setCity(e.target.value)} className="field mt-1 w-full" />
          </div>
          <div>
            <label className="text-sm font-bold text-ink">State</label>
            <input type="text" value={state} onChange={(e) => setState(e.target.value)} placeholder="2-letter, e.g. TX" maxLength={2} className="field mt-1 w-full" />
          </div>
          <div>
            <label className="text-sm font-bold text-ink">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as ProposalPriority)} className="field mt-1 w-full">
              <option value="">(none)</option>
              {PROPOSAL_PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-bold text-ink">NTE ($)</label>
            <input
              type="number"
              inputMode="decimal"
              value={nte}
              onChange={(e) => setNte(e.target.value)}
              placeholder="Client's Not-To-Exceed"
              className="field mt-1 w-full"
            />
          </div>
        </div>

        <div>
          <label className="text-sm font-bold text-ink">Proposal (narrative + pricing breakdown)</label>
          <textarea
            value={proposalText}
            onChange={(e) => setProposalText(e.target.value)}
            placeholder="Paste the full proposal here -- scope of work, findings, recommendation, and the line items with their prices..."
            rows={10}
            className="field mt-1 w-full font-mono text-xs"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          variant="primary"
          icon={checking ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
          disabled={checking}
          onClick={handleCheck}
        >
          {checking ? 'Checking...' : 'Check & Fix'}
        </Button>
      </Panel>

      {result && (
        <>
          <Panel className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-ink">Corrected Breakdown</p>
              <Button variant="secondary" size="sm" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copyText}>
                {copied ? 'Copied' : 'Copy as text'}
              </Button>
            </div>
            {result.narrative_scope && <p className="text-sm text-ink-soft whitespace-pre-wrap">{result.narrative_scope}</p>}

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="table-head-row">
                    <th className="px-4 py-2">Description</th>
                    <th className="px-4 py-2 text-right">Qty</th>
                    <th className="px-4 py-2 text-right">Unit Price</th>
                    <th className="px-4 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.corrected_line_items.map((li, i) => (
                    <tr key={i} className="table-row">
                      <td className="px-4 py-2.5 text-ink">
                        {li.description}
                        {li.changed && <Badge variant="brand">Fixed</Badge>}
                        {li.changed && li.note && <p className="text-xs text-ink-faint mt-0.5">{li.note}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink-soft tabular-nums">{li.quantity}</td>
                      <td className="px-4 py-2.5 text-right text-ink-soft tabular-nums">${li.unit_price.toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-right text-ink tabular-nums">${(li.quantity * li.unit_price).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="px-4 py-2.5 text-right font-bold text-ink">Total</td>
                    <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">${result.subtotal_after.toFixed(2)}</td>
                  </tr>
                  {Math.abs(result.subtotal_after - result.subtotal_before) > 0.01 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-1 text-right text-xs text-ink-faint">As pasted</td>
                      <td className="px-4 py-1 text-right text-xs text-ink-faint tabular-nums">${result.subtotal_before.toFixed(2)}</td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          </Panel>

          {result.fixes_applied.length > 0 && (
            <Panel className="p-4 space-y-2">
              <p className="text-sm font-bold text-ink">What we fixed</p>
              <ul className="space-y-1.5">
                {result.fixes_applied.map((f, i) => (
                  <li key={i} className="text-sm text-ink-soft flex items-start gap-2">
                    <Check size={15} className="shrink-0 mt-0.5 text-good" />
                    {f.message}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel className="p-4 space-y-2">
            <p className="text-sm font-bold text-ink">Still needs your review</p>
            {result.overall_assessment && <p className="text-sm text-ink-soft italic">{result.overall_assessment}</p>}
            {result.scope_findings.length === 0 ? (
              <p className="text-sm text-good">Narrative and line items look consistent.</p>
            ) : (
              <ul className="space-y-2">
                {result.scope_findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 rounded-lg border border-line bg-canvas p-3">
                    <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity.toUpperCase()}</Badge>
                    <div className="space-y-0.5 flex-1">
                      <span className="text-xs font-semibold text-ink-faint">{CATEGORY_LABELS[f.category] ?? f.category}</span>
                      <p className="text-sm text-ink">{f.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {result.ai_learning && result.ai_learning.outcomes_considered > 0 && (
              <p className="text-xs text-ink-faint">
                Checked against {result.ai_learning.outcomes_considered} historical AI Learning outcomes ({result.ai_learning.scope_label}).
              </p>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
