export type Role = 'super_admin' | 'data_entry' | 'dispatcher'

export interface Profile {
  id: string
  display_name: string
  role: Role
  dispatcher_name: string | null
  app_ivr: number | null
  system_usage: number | null
  created_at?: string
  updated_at?: string
}

export interface WorkOrder {
  wo: string
  dispatcher: string | null
  client: string | null
  status: string | null
  wo_date: string | null
  eta: string | null
  trade: string | null
  subtrade: string | null
  address: string | null
  city: string | null
  state: string | null
  nte: number | null
  nte_approved: boolean | null
  cost: number | null
  profit_pct: number | null
  description: string | null
  quote_sent_on: string | null
  admin_notes: string | null
  tl_notes: string | null
  invoiced_on: string | null
  // Filled in asynchronously by the geocode-work-orders edge function from the address
  // fields above -- null until that background job resolves this row's address.
  lat?: number | null
  lng?: number | null
  updated_at?: string
  // -- Operational KPI fields (Oct 2026 expansion) --
  actual_visit_date: string | null
  first_visit_complete: boolean | null
  is_assessment_visit: boolean | null
  assessment_fee: number | null
  assessment_paid_on: string | null
  reassigned_from: string | null
  reassigned_to: string | null
  reassigned_on: string | null
  recall_of_wo: string | null
  job_completed_on: string | null
  closed_on: string | null
  technician_name: string | null
  technicians_count: number | null
  tech_complaint: boolean | null
  tech_complaint_notes: string | null
}

// ---- Proposal Builder ----

export type ProposalStatus = 'draft' | 'ai_generated' | 'in_review' | 'approved' | 'sent'

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: 'Draft',
  ai_generated: 'AI Drafted',
  in_review: 'In Review',
  approved: 'Approved',
  sent: 'Sent',
}

export type LineItemKind = 'labor' | 'part' | 'other'

export interface LaborRate {
  id: string
  role_name: string
  hourly_cost: number
  active: boolean
  created_at?: string
  updated_at?: string
}

export interface PartItem {
  id: string
  sku: string | null
  name: string
  unit_cost: number
  unit: string
  category: string | null
  active: boolean
  created_at?: string
  updated_at?: string
}

export interface ProposalLineItem {
  id: string
  proposal_id: string
  kind: LineItemKind
  description: string
  role_id: string | null
  part_id: string | null
  quantity: number
  unit_cost: number
  unit_price: number
  needs_manual_pricing: boolean
  ai_suggested: boolean
  sort_order: number
  created_at?: string
  updated_at?: string
}

export interface ProposalPhoto {
  id: string
  proposal_id: string
  storage_path: string
  caption: string | null
  sort_order: number
  uploaded_by: string | null
  created_at?: string
}

export interface Proposal {
  id: string
  wo: string
  dispatcher_name: string | null
  // Dispatcher-entered client name for this specific proposal -- feeds the
  // AI prompt so it knows who the proposal is for even when the linked work
  // order's own client field is blank. Falls back to the work order's
  // client in the UI and the AI prompt when this is empty.
  client_name: string | null
  version: number
  status: ProposalStatus
  markup_pct: number
  narrative_scope: string | null
  narrative_findings: string | null
  narrative_recommendation: string | null
  terms: string | null
  technician_notes: string | null
  technician_rate: number | null
  helper_rate: number | null
  technician_flat_quote: number | null
  trip_fee: number | null
  assessment_fee: number | null
  ai_model: string | null
  ai_generated_at: string | null
  ai_raw_response: unknown
  // Dispatcher-only note from the AI (never shown to the client): set when it
  // couldn't reasonably reach the flat-quote markup target without inventing
  // scope, naming a realistic ceiling price and suggesting the technician's
  // flat quote be negotiated down.
  ai_pricing_note: string | null
  subtotal_cost: number
  subtotal_price: number
  margin_pct: number | null
  created_by: string | null
  approved_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

// ---- AI Learning: labeled quote outcomes (approved/rejected/revision), used
// as context the AI reads when pricing new proposals, so it can calibrate
// toward what has actually gotten approved before. Rows can come from a
// historical quote entered by hand (proposal_id null) or from a proposal
// that was actually sent through this app (proposal_id set). ----

export type QuoteOutcomeResult = 'approved' | 'rejected' | 'revision_requested'

export const QUOTE_OUTCOME_LABELS: Record<QuoteOutcomeResult, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  revision_requested: 'Asked to revise / lower price',
}

export interface QuoteOutcome {
  id: string
  proposal_id: string | null
  dispatcher_name: string | null
  client: string | null
  store: string | null
  trade: string | null
  subtrade: string | null
  job_description: string | null
  total_price: number | null
  total_cost: number | null
  markup_pct: number | null
  outcome: QuoteOutcomeResult
  client_feedback: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// ---- Dispatch Agent ("Raley") activity -- read-only view onto the separate
// nexafix-dispatch Supabase project, surfaced here via the
// dispatch-agent-activity edge function. See README for the two-system split. ----

export interface DispatchTechnicianSummary {
  id: string
  name: string
  company: string | null
  phone: string | null
  status: string | null
}

export interface DispatchOrderSummary {
  id: string
  title: string
  trade: string | null
  location: string
  description: string | null
  urgency: string | null
  repair_ceiling: number | null
  assessment_target: number | null
  ground_rules: string | null
  status: string
  auto_dispatch: boolean
  updated_at: string
  // Free-text note the dispatcher leaves for Raley -- it sees this on every
  // call about this job until the note is cleared.
  office_note: string | null
  assigned_technician_id: string | null
  assigned_technician: { name: string; company: string | null; phone: string | null } | null
  technicians: DispatchTechnicianSummary[]
}

// Outbound calls -- Raley calling a technician. See DispatchInboundCall for
// the other direction (someone calling Raley's number back).
export interface DispatchCallEventSummary {
  id: string
  order_title: string | null
  technician_name: string | null
  call_sid: string | null
  provider: string | null
  event_type: string | null
  ended_reason: string | null
  duration_seconds: number | null
  cost: number | null
  summary: string | null
  transcript: string | null
  recording_url: string | null
  // 'inbound' | 'outbound' | null -- read straight off Vapi's structured
  // call data, the same way Raley's own dashboard labels its call history
  // (see dispatch-agent-activity's eventDirection for exactly how).
  direction: 'inbound' | 'outbound' | null
  created_at: string
}

export interface DispatchAlertSummary {
  id: string
  level: string
  message: string
  source: string | null
  context: string | null
  order_title: string | null
  technician_name: string | null
  created_at: string
}

// Inbound calls -- someone calling Raley's own number back (a callback, a
// question about a job, etc). The "incoming" half of call tracking.
export interface DispatchInboundCall {
  id: string
  call_id: string | null
  phone: string | null
  caller_name: string | null
  technician_name: string | null
  order_title: string | null
  reason: string | null
  message: string | null
  summary: string | null
  transcript: string | null
  recording_url: string | null
  callback_requested: boolean
  handled: boolean
  created_at: string
}

// A fee-approval request Raley raised (e.g. an assessment fee above the
// usual ceiling) that's waiting on, or has already received, a decision.
export interface DispatchApprovalSummary {
  id: string
  order_title: string | null
  kind: string | null
  requested_amount: number | null
  decided_amount: number | null
  status: string
  decision_note: string | null
  created_at: string
}

export interface DispatchLiveLine {
  role: string | null
  text: string
  created_at: string
}

// A call that's in progress right now, with its transcript so far -- no
// technician/order link is available until the call ends and it becomes a
// normal DispatchCallEventSummary row.
export interface DispatchActiveCall {
  call_sid: string
  started_at: string
  updated_at: string
  // Inferred (no structured call data exists yet for a call still in
  // progress): 'outbound' if we have a "call-started" row for this call,
  // 'inbound' otherwise -- see dispatch-agent-activity for the exact logic.
  direction: 'inbound' | 'outbound'
  // Only populated for outbound calls (read off their call-started row) --
  // an inbound call has no order/technician link until it's done.
  order_title: string | null
  technician_name: string | null
  purpose: string | null
  lines: DispatchLiveLine[]
}

export interface DispatchActivity {
  orders: DispatchOrderSummary[]
  events: DispatchCallEventSummary[]
  alerts: DispatchAlertSummary[]
  inbox: DispatchInboundCall[]
  approvals: DispatchApprovalSummary[]
  live_calls: DispatchActiveCall[]
  fetched_at: string
}

// ---- Writes into Raley, via the raley-actions edge function. See that
// function's header comment for why this proxies Raley's own API instead of
// reimplementing it. ----

export interface NewDispatchOrder {
  title: string
  location: string
  trade?: string
  description?: string
  urgency?: 'Routine' | 'Priority' | 'Emergency'
  repair_ceiling: number
  assessment_target?: number | null
  ground_rules?: string
  auto_dispatch?: boolean
}

// Partial edit of an existing order -- same field shape as NewDispatchOrder
// minus the required-on-create constraints, since any subset can be saved.
export interface DispatchOrderPatch {
  title?: string
  location?: string
  trade?: string | null
  description?: string | null
  urgency?: 'Routine' | 'Priority' | 'Emergency'
  repair_ceiling?: number
  assessment_target?: number | null
  ground_rules?: string | null
  office_note?: string | null
}

// Manually add a technician as a candidate on an existing order -- the same
// "Manually added" path Raley's own data already shows for every technician
// on file (see raley-actions' add_technician action).
export interface NewDispatchTechnician {
  name: string
  company?: string
  phone?: string
  email?: string
  notes?: string
}

export const STATUS_OPTIONS = [
  'Assigned',
  'OnSite',
  'Needs Proposal',
  'Revised Quote Needed',
  'Approved Not Scheduled',
  'Parts Needed',
  'Awaiting Advice',
  'Awaiting Approval',
  'Return Trip Needed',
  'Reassigned',
  'Job Done',
  'Billed For Incurred',
] as const
