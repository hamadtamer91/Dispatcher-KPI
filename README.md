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

Deploy with `supabase functions deploy <name> --project-ref aejtnodojscvolcejrdx` (or via the Supabase MCP tool / dashboard). Secrets (`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SHARE_URL`, `MS_TABLE_NAME`, `GEMINI_MODEL`, Gemini API key) are set as Edge Function secrets in the Supabase dashboard, not in this repo.

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

Deploys run through Vercel, connected to this repository's `main` branch — pushing to `main` builds and deploys automatically; other branches/PRs get preview deployments. Project env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) are set in the Vercel project settings.

## Known constraints

- **Excel is still authoritative** for the original work-order fields (see `sync-excel-kpi` above). Don't treat a direct edit to those fields in the dashboard as permanent until the Excel sync is retired.
- Several text fields (`dispatcher`, `trade`, `subtrade`, `technician_name`, `city`, `state`) are free-text with no dropdown/autocomplete, which risks fragmenting KPI groupings (e.g. "Electrical" vs "electrical").
- No automated test suite exists yet.
