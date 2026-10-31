import { useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutGrid, ClipboardList, Users, Building2, LogOut, BarChart3,
  Map as MapIcon, FileText, Tags, Phone, Menu, X, Sparkles, ClipboardCheck, ShieldCheck,
} from 'lucide-react'
import { useAuth } from './hooks/useAuth'
import { useLiveCallCount } from './hooks/useLiveCallCount'
import { EntityScopeProvider, useEntityScope } from './contexts/EntityScopeContext'
import { canAccessTab, ROLE_LABELS } from './lib/permissions'
import type { TabKey } from './lib/permissions'
import { LoginPage } from './pages/LoginPage'
import { WorkOrdersPage } from './pages/WorkOrdersPage'
import { KPIOverviewPage } from './pages/KPIOverviewPage'
import { AnalyticsPage } from './pages/AnalyticsPage'
import { ManageUsersPage } from './pages/ManageUsersPage'
import { ClientReportsPage } from './pages/ClientReportsPage'
import { DispatcherDetailPage } from './pages/DispatcherDetailPage'
import { DispatcherView } from './pages/DispatcherView'
import { MapPage } from './pages/MapPage'
import { ProposalsPage } from './pages/ProposalsPage'
import { ProposalDetailPage } from './pages/ProposalDetailPage'
import { BreakdownPage } from './pages/BreakdownPage'
import { BreakdownPastePage } from './pages/BreakdownPastePage'
import { BreakdownDetailPage } from './pages/BreakdownDetailPage'
import { TeamLeaderCheckPage } from './pages/TeamLeaderCheckPage'
import { PriceListsPage } from './pages/PriceListsPage'
import { DispatchAgentPage } from './pages/DispatchAgentPage'
import { AiLearningPage } from './pages/AiLearningPage'
import type { Role } from './lib/types'

interface NavEntry<T extends string> {
  key: T
  label: string
  icon: React.ReactNode
  // Small count pill next to the label -- used for "calls live right now"
  // on the Dispatch Agent item. Omit or 0 shows nothing.
  badge?: number
}
interface NavGroup<T extends string> {
  label: string
  items: NavEntry<T>[]
}

export default function App() {
  const { session, profile, loading, error, signIn, signOut } = useAuth()
  const liveCallCount = useLiveCallCount(!!session)
  const [tab, setTab] = useState<TabKey>('work_orders')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const goTab = (t: TabKey) => {
    setTab(t)
    navigate('/')
    setMobileNavOpen(false)
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-ink-faint bg-canvas">Loading...</div>
  }

  if (!session) {
    return <LoginPage signIn={signIn} error={error} />
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas px-4">
        <div className="max-w-sm text-center space-y-4">
          <p className="text-sm text-warn bg-warn-tint border border-warn/20 rounded-xl p-4">{error || 'No profile found for this account.'}</p>
          <button onClick={signOut} className="text-sm font-medium text-ink-soft hover:text-ink">Sign out</button>
        </div>
      </div>
    )
  }

  const role: Role = profile.role
  // A dispatcher lands on My Jobs; everyone else on Work Orders. If the tab
  // held in state isn't one this role can open (e.g. the default before the
  // profile loaded), fall back to the landing tab.
  const landingTab: TabKey = role === 'dispatcher' ? 'jobs' : 'work_orders'
  const activeTab: TabKey = canAccessTab(role, tab) ? tab : landingTab

  // Every tab that exists, in sidebar order. What each role actually sees is
  // decided by TAB_ACCESS in lib/permissions.ts -- items a role can't open
  // are filtered out below, and groups left empty disappear.
  const allGroups: NavGroup<TabKey>[] = [
    {
      label: 'Workspace',
      items: [
        { key: 'jobs', label: 'My Jobs', icon: <ClipboardList size={17} /> },
        { key: 'work_orders', label: 'Work Orders', icon: <ClipboardList size={17} /> },
        { key: 'kpi', label: 'KPI Overview', icon: <LayoutGrid size={17} /> },
        { key: 'analytics', label: 'Analytics', icon: <BarChart3 size={17} /> },
        { key: 'map', label: 'Map', icon: <MapIcon size={17} /> },
      ],
    },
    {
      label: 'Sales',
      items: [
        { key: 'breakdown', label: 'Breakdown', icon: <ClipboardCheck size={17} /> },
        { key: 'tl_check', label: 'Team Leader Check', icon: <ShieldCheck size={17} /> },
        { key: 'proposals', label: 'Proposals', icon: <FileText size={17} /> },
        { key: 'price_lists', label: 'Price Lists', icon: <Tags size={17} /> },
        { key: 'ai_learning', label: 'AI Learning', icon: <Sparkles size={17} /> },
      ],
    },
    {
      label: 'Automation',
      items: [{ key: 'dispatch_agent', label: 'Dispatch Agent', icon: <Phone size={17} />, badge: liveCallCount.total }],
    },
    {
      label: 'Management',
      items: [
        { key: 'users', label: 'Manage Users', icon: <Users size={17} /> },
        { key: 'clients', label: 'Client Reports', icon: <Building2 size={17} /> },
      ],
    },
  ]
  const navGroups = allGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => canAccessTab(role, i.key)) }))
    .filter((g) => g.items.length > 0)

  const sidebarBody = <SidebarNav groups={navGroups} active={activeTab} onSelect={goTab} />

  const motionKey = location.pathname === '/' ? `t-${activeTab}` : location.pathname

  const pageContent = (
    <Routes location={location}>
      <Route path="/dispatcher/:name" element={<DispatcherDetailPage />} />
      <Route path="/proposals/:id" element={<ProposalDetailPage role={role} />} />
      <Route path="/breakdown/paste" element={<BreakdownPastePage />} />
      <Route path="/breakdown/:id" element={<BreakdownDetailPage />} />
      <Route
        path="*"
        element={
          <>
            {activeTab === 'jobs' && <DispatcherView dispatcherName={profile.dispatcher_name} />}
            {activeTab === 'work_orders' && <WorkOrdersPage role={role} />}
            {activeTab === 'kpi' && <KPIOverviewPage />}
            {activeTab === 'analytics' && <AnalyticsPage />}
            {activeTab === 'map' && <MapPage />}
            {activeTab === 'breakdown' && <BreakdownPage />}
            {activeTab === 'tl_check' && <TeamLeaderCheckPage />}
            {activeTab === 'proposals' && (
              <ProposalsPage role={role} dispatcherName={profile.dispatcher_name} />
            )}
            {activeTab === 'price_lists' && <PriceListsPage role={role} />}
            {activeTab === 'ai_learning' && <AiLearningPage />}
            {activeTab === 'dispatch_agent' && (
              <DispatchAgentPage dispatcherName={role === 'dispatcher' ? profile.dispatcher_name : undefined} />
            )}
            {activeTab === 'users' && <ManageUsersPage />}
            {activeTab === 'clients' && <ClientReportsPage />}
          </>
        }
      />
    </Routes>
  )

  return (
    <EntityScopeProvider profile={profile}>
      <div className="min-h-screen bg-canvas md:flex">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 border-r border-line bg-white">
          <BrandMark />
          <div className="flex-1 overflow-y-auto px-3 py-2">{sidebarBody}</div>
          <EntitySwitcher />
          <UserCard name={profile.display_name} role={role} onSignOut={signOut} />
        </aside>

        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 bg-white border-b border-line flex items-center justify-between px-4 py-3">
          <BrandMark compact />
          <button onClick={() => setMobileNavOpen(true)} className="btn-icon">
            <Menu size={20} />
          </button>
        </div>

        {/* Mobile slide-over nav */}
        <AnimatePresence>
          {mobileNavOpen && (
            <>
              <motion.div
                className="fixed inset-0 bg-ink/40 z-40 md:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setMobileNavOpen(false)}
              />
              <motion.aside
                className="fixed inset-y-0 left-0 w-72 bg-white z-50 flex flex-col md:hidden"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                <div className="flex items-center justify-between px-4 py-4 border-b border-line-soft">
                  <BrandMark compact />
                  <button onClick={() => setMobileNavOpen(false)} className="btn-icon">
                    <X size={18} />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-2">{sidebarBody}</div>
                <EntitySwitcher />
                <UserCard name={profile.display_name} role={role} onSignOut={signOut} />
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <main className="flex-1 md:ml-60 min-w-0">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={motionKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {pageContent}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </EntityScopeProvider>
  )
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${compact ? '' : 'px-4 py-5 border-b border-line-soft'}`}>
      <div className="w-8 h-8 rounded-lg bg-brand-600 text-white font-extrabold text-sm flex items-center justify-center shrink-0">
        N
      </div>
      <div className="leading-tight">
        <p className="text-sm font-bold text-ink">NGVS</p>
        <p className="text-[11px] text-ink-faint -mt-0.5">Dispatch Console</p>
      </div>
    </div>
  )
}

// Lets a super_admin pick which entity's Work Orders, Proposals, AI Learning
// and Price Lists they're currently viewing and creating under. Hidden for
// everyone else since RLS already locks them to their own entity.
function EntitySwitcher() {
  const { switchableEntities, activeEntityId, setActiveEntityId } = useEntityScope()
  if (switchableEntities.length === 0) return null
  return (
    <div className="border-t border-line-soft px-3 py-2.5">
      <label className="block text-[10px] font-bold text-ink-faint uppercase tracking-wide mb-1">Entity</label>
      <select
        value={activeEntityId}
        onChange={(e) => setActiveEntityId(e.target.value)}
        className="field w-full text-sm py-1.5"
      >
        {switchableEntities.map((e) => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
      </select>
    </div>
  )
}

function UserCard({ name, role, onSignOut }: { name: string; role: Role; onSignOut: () => void }) {
  // Super_admin already sees (and can change) their active entity in the
  // switcher just above this card -- repeating it here would be noise.
  const { activeEntityName, isSuperAdmin } = useEntityScope()
  return (
    <div className="border-t border-line-soft px-3 py-3 flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-full bg-brand-50 text-brand-700 font-bold text-xs flex items-center justify-center shrink-0">
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink truncate">{name}</p>
        <p className="text-xs text-ink-faint truncate">
          {ROLE_LABELS[role] ?? role}{!isSuperAdmin && activeEntityName ? ` · ${activeEntityName}` : ''}
        </p>
      </div>
      <button onClick={onSignOut} className="btn-icon" title="Sign out">
        <LogOut size={16} />
      </button>
    </div>
  )
}

function SidebarNav<T extends string>({
  groups,
  active,
  onSelect,
}: {
  groups: NavGroup<T>[]
  active: T
  onSelect: (key: T) => void
}) {
  return (
    <nav className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="text-[11px] font-bold text-ink-faint px-3 mb-1.5">{group.label}</p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = item.key === active
              return (
                <button
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                  className="relative w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-semibold text-left transition-colors"
                  style={{ color: isActive ? 'var(--color-brand-700)' : 'var(--color-ink-soft)' }}
                >
                  {isActive && (
                    <motion.div
                      layoutId="nav-active-pill"
                      className="absolute inset-0 bg-brand-50 rounded-lg"
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                    />
                  )}
                  <span className="relative z-10 shrink-0">{item.icon}</span>
                  <span className="relative z-10 truncate">{item.label}</span>
                  {!!item.badge && (
                    <span
                      className="relative z-10 ml-auto shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[11px] font-bold text-white"
                      style={{ backgroundColor: 'var(--color-danger)' }}
                      title={`${item.badge} call${item.badge === 1 ? '' : 's'} live right now`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}
