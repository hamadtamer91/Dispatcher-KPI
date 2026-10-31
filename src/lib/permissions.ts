import type { Profile, Role } from './types'

// One place that decides who can see and do what. The sidebar, the screens and
// the Manage Users page all read from here, so changing a rule later is a
// one-line edit. The database enforces the same rules independently (row-level
// security) -- hiding a tab here is never the only lock on the data itself.

export type TabKey =
  | 'jobs'
  | 'work_orders'
  | 'kpi'
  | 'analytics'
  | 'map'
  | 'breakdown'
  | 'tl_check'
  | 'proposals'
  | 'price_lists'
  | 'ai_learning'
  | 'dispatch_agent'
  | 'users'
  | 'clients'

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  account_manager: 'Account Manager',
  team_leader: 'Team Leader',
  dispatcher: 'Dispatcher',
  data_entry: 'Data Entry (old)',
}

const EVERYONE: Role[] = ['super_admin', 'admin', 'account_manager', 'team_leader', 'dispatcher', 'data_entry']
// Everyone except the dispatcher -- the "office" roles that see the full Work Orders list.
const OFFICE: Role[] = ['super_admin', 'admin', 'account_manager', 'team_leader', 'data_entry']

export const TAB_ACCESS: Record<TabKey, readonly Role[]> = {
  jobs: ['dispatcher'],
  work_orders: OFFICE,
  kpi: EVERYONE,
  analytics: EVERYONE,
  map: EVERYONE,
  breakdown: EVERYONE,
  tl_check: OFFICE,
  proposals: EVERYONE,
  price_lists: EVERYONE,
  ai_learning: OFFICE,
  dispatch_agent: ['super_admin', 'account_manager', 'team_leader', 'dispatcher', 'data_entry'],
  users: ['super_admin', 'admin'],
  clients: ['super_admin', 'admin', 'account_manager', 'team_leader'],
}

export function canAccessTab(role: Role, tab: TabKey): boolean {
  return TAB_ACCESS[tab].includes(role)
}

/** Add, edit and import work orders. */
export function canEditWorkOrders(role: Role): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'data_entry'
}

/** Permanently delete a work order. */
export function canDeleteWorkOrders(role: Role): boolean {
  return role === 'super_admin' || role === 'data_entry'
}

/** Change labor rates and the parts catalog. Everyone else sees them read-only. */
export function canEditPriceLists(role: Role): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'data_entry'
}

// Roles an Admin is allowed to create and manage (always inside their own entity).
const ADMIN_MANAGEABLE: Role[] = ['account_manager', 'team_leader', 'dispatcher']

/** Roles this viewer can pick when creating a login or changing someone's role. */
export function assignableRoles(viewerRole: Role): Role[] {
  if (viewerRole === 'super_admin') return ['super_admin', 'admin', 'account_manager', 'team_leader', 'dispatcher']
  if (viewerRole === 'admin') return ADMIN_MANAGEABLE
  return []
}

/** Whether this viewer may edit, re-role, reset the password of, or remove this person. */
export function canManageUser(viewerRole: Role, target: Pick<Profile, 'role'>): boolean {
  if (viewerRole === 'super_admin') return true
  if (viewerRole === 'admin') return ADMIN_MANAGEABLE.includes(target.role)
  return false
}

/**
 * Which dispatchers' KPIs this viewer is allowed to see, by dispatcher name.
 *  - a dispatcher: only themselves
 *  - a team leader: the dispatchers on their team
 *  - everyone else: no limit (null)
 */
export function kpiScopeNames(viewer: Profile, profiles: Profile[]): Set<string> | null {
  if (viewer.role === 'dispatcher') {
    return new Set(viewer.dispatcher_name ? [viewer.dispatcher_name.trim()] : [])
  }
  if (viewer.role === 'team_leader') {
    return new Set(
      profiles
        .filter((p) => p.team_leader_id === viewer.id && p.dispatcher_name)
        .map((p) => (p.dispatcher_name as string).trim()),
    )
  }
  return null
}
