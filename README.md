# Dispatcher KPI Dashboard

Internal operations dashboard for NGVS dispatchers, admins, and data-entry staff. Tracks work orders, dispatcher KPIs, AI-assisted repair proposals, and client reporting.

- **Live app:** https://dispatcher-kpi.vercel.app
- **Stack:** Vite + React 19 + TypeScript, Tailwind, Supabase (Postgres + Auth + Edge Functions), deployed on Vercel.

## Architecture at a glance

```
src/
  pages/        One component per route/tab (WorkOrdersPage, KPIOverviewPage, AnalyticsPage,
                 MapPage, ProposalsPage, PriceListsPage, ManageUsersPage, ClientReportsPage,
                 DispatcherView/DispatcherDetailPage, LoginPage, ProposalDetailPage)
  components/    Shared UI (WorkOrderModal, WorkOrdersMap, DispatcherStats, charts)
  hooks/         Data access against Supabase (useWorkOrders, useProposals, useProfiles,
                 usePriceLists, useProposalDetail, useAuth)
  lib/           Supabase client, shared types
```

Access is role-gated client-side (`super_admin`, `data_entry`, `dispatcher`) and enforced server-side by Postgres Row Level Security — dispatchers only see their own jobs; only admins/data-entry can write.

### Supabase project
Project: `nexafix-dispatcher-kpi` (id `aejtnodojscvolcejrdx`), org `ovwnyqwmmkfpfktidudr`, region us-east-1.

Key tables: `work_orders`, `profiles`, `proposals`, `proposal_line_items`, `proposal_photos`, `labor_rates`, `parts_price_list`, `geocode_cache`. All have RLS enabled.

### Edge Functions
| Function | Purpose |
|---|---|
| `generate-proposal` | Gemini-based AI drafting of repair proposals — reads the work order, technician notes, and photos; writes narrative + parts/labor line items. Has a separate flat-quote mode that skips AI parts estimation. |
| `sync-excel-kpi` | **One-way Excel → Supabase sync**, run every 3 minutes by a pg_cron job. Reads a Microsoft Graph–hosted Excel table and upserts the ~19 original `work_orders` columns (status, cost, NTE, dispatcher, dates, notes, etc.) by `wo`. **Excel is still the system of record for these columns** — any direct edit to them in the dashboard is overwritten on the next sync. The 13 "Oct 2026 operational KPI" columns (`actual_visit_date`, `technician_name`, `job_completed_on`, etc.) are never touched by this sync and are dashboard-only. |
| `geocode-work-orders` | Runs every 2 minutes via pg_cron; geocodes addresses into `geocode_cache` for the map view. |
| `dispatch-agent-activity` | Read-only bridge to the *separate* `nexafix-dispatch` Supabase project that backs the AI dispatch agent ("Raley") — see below. |

Deploy with `supabase functions deploy <name> --project-ref aejtnodojscvolcejrdx` (or via the Supabase MCP tool / dashboard). Secrets (`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SHARE_URL`, `MS_TABLE_NAME`, `GEMINI_MODEL`, Gemini API key, `DISPATCH_AGENT_SUPABASE_URL`, `DISPATCH_AGENT_SUPABASE_SERVICE_ROLE_KEY`) are set as Edge Function secrets in the Supabase dashboard, not in this repo.

### Raley — the AI dispatch agent (separate system, linked read-only)

NexaFix also runs an autonomous AI voice agent ("Raley") that calls technicians to source and
negotiate job assignments. It is a **deliberately separate system**, not a module of this app:

- Its own Supabase project, `nexafix-dispatch` (`jzcrbauxjxjahfxvlwlr`), with a multi-tenant
  schema (`organizations`, `ai_dispatch_orders`, `ai_dispatch_technicians`, `ai_dispatch_call_events`,
  `ai_dispatch_tech_memory`, `ai_dispatch_approvals`, `ai_dispatch_alerts`, `ai_dispatch_inbox`).
  There is no join key between `ai_dispatch_orders` and this app's `work_orders` — they are
  unrelated concepts of "order."
- Its own Vercel app (`nexafix-voice-agent`) with the call-orchestration API routes, plus a
  standalone WebSocket relay (`nexafix-voice-relay`, on Render) that bridges live Twilio call
  audio to the agent logic (Claude + Vapi).

Why not merge them: the dashboard is a synchronous CRUD/reporting tool; Raley is an async,
external-API-heavy pipeline (Twilio/Vapi/Claude/a scheduler) with its own SaaS-style multi-tenant
design already in its schema. Combining codebases/databases would entangle two very different
failure modes for little benefit and would complicate ever spinning Raley out as its own product.

Instead, this app has a **read-only window** onto Raley's activity: the `dispatch-agent-activity`
edge function (above) uses Raley's service role key — held only as an Edge Function secret here,
never in the browser — to read its recent orders, assigned technicians, call events, and
unresolved alerts, and the "Dispatch Agent" tab in the UI renders that summary. Nothing written
here ever reaches Raley's database, and nothing in `work_orders` is touched by this.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL + publishable key
npm run dev
```

```bash
npm run build     # tsc -b && vite build
npm run lint       # oxlint
npm run preview
```

## Deployment

The Vercel project (`dispatcher-kpi`, framework: Vite) is **not yet connected to this GitHub
repo** — pushing to `main` does not auto-deploy yet. Until that's wired up, deploys are pushed
manually to Vercel. Project env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) are
set in the Vercel project settings. Connecting Vercel's Git integration to this repo is the next
step once GitHub push access is sorted out (see commit history / team notes).

## Known constraints

- **Excel is still authoritative** for the original work-order fields (see `sync-excel-kpi` above). Don't treat a direct edit to those fields in the dashboard as permanent until the Excel sync is retired.
- Several text fields (`dispatcher`, `trade`, `subtrade`, `technician_name`, `city`, `state`) are free-text with no dropdown/autocomplete, which risks fragmenting KPI groupings (e.g. "Electrical" vs "electrical").
- No automated test suite exists yet.
