import { useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutGrid, ClipboardList, Users, Building2, LogOut, BarChart3,
  Map as MapIcon, FileText, Tags, Phone, Menu, X,
} from 'lucide-react'
import { useAuth } from './hooks/useAuth'
import { useLiveCallCount } from './hooks/useLiveCallCount'
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
import { PriceListsPage } from './pages/PriceListsPage'
import { DispatchAgentPage } from './pages/DispatchAgentPage'

type Tab = 'work_orders' | 'kpi' | 'analytics' | 'map' | 'users' | 'clients' | 'proposals' | 'price_lists' | 'dispatch_agent'
type DispatcherTab = 'jobs' | 'proposals' | 'price_lists' | 'dispatch_agent'

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
  const [tab, setTab] = useState<Tab>('work_orders')
  const [dispatcherTab, setDispatcherTab] = useState<DispatcherTab>('jobs')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const goTab = (t: Tab) => {
    setTab(t)
    navigate('/')
    setMobileNavOpen(false)
  }

  const goDispatcherTab = (t: DispatcherTab) => {
    setDispatcherTab(t)
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

  const isDispatcherOnly = profile.role === 'dispatcher'

  const adminGroups: NavGroup<Tab>[] = [
    {
      label: 'Workspace',
      items: [
        { key: 'work_orders', label: 'Work Orders', icon: <ClipboardList size={17} /> },
        { key: 'kpi', label: 'KPI Overview', icon: <LayoutGrid size={17} /> },
        { key: 'analytics', label: 'Analytics', icon: <BarChart3 size={17} /> },
        { key: 'map', label: 'Map', icon: <MapIcon size={17} /> },
      ],
    },
    {
      label: 'Sales',
      items: [
        { key: 'proposals', label: 'Proposals', icon: <FileText size={17} /> },
        { key: 'price_lists', label: 'Price Lists', icon: <Tags size={17} /> },
      ],
    },
    {
      label: 'Automation',
      items: [{ key: 'dispatch_agent', label: 'Dispatch Agent', icon: <Phone size={17} />, badge: liveCallCount.total }],
    },
    ...(profile.role === 'super_admin'
      ? [{
          label: 'Admin',
          items: [
            { key: 'users' as Tab, label: 'Manage Users', icon: <Users size={17} /> },
            { key: 'clients' as Tab, label: 'Store Reports', icon: <Building2 size={17} /> },
          ],
        }]
      : []),
  ]

  const dispatcherGroups: NavGroup<DispatcherTab>[] = [
    {
      label: 'Workspace',
      items: [
        { key: 'jobs', label: 'My Jobs', icon: <ClipboardList size={17} /> },
        { key: 'proposals', label: 'Proposals', icon: <FileText size={17} /> },
        { key: 'price_lists', label: 'Price Lists', icon: <Tags size={17} /> },
      ],
    },
    {
      label: 'Automation',
      items: [{ key: 'dispatch_agent', label: 'Dispatch Agent', icon: <Phone size={17} />, badge: liveCallCount.total }],
    },
  ]

  const sidebarBody = isDispatcherOnly ? (
    <SidebarNav groups={dispatcherGroups} active={dispatcherTab} onSelect={goDispatcherTab} />
  ) : (
    <SidebarNav groups={adminGroups} active={tab} onSelect={goTab} />
  )

  const motionKey = location.pathname === '/'
    ? (isDispatcherOnly ? `d-${dispatcherTab}` : `t-${tab}`)
    : location.pathname

  const pageContent = isDispatcherOnly ? (
    <Routes location={location}>
      <Route path="/proposals/:id" element={<ProposalDetailPage />} />
      <Route
        path="*"
        element={
          <>
            {dispatcherTab === 'jobs' && <DispatcherView dispatcherName={profile.dispatcher_name} />}
            {dispatcherTab === 'proposals' && (
              <ProposalsPage role={profile.role} dispatcherName={profile.dispatcher_name} />
            )}
            {dispatcherTab === 'price_lists' && <PriceListsPage />}
            {dispatcherTab === 'dispatch_agent' && <DispatchAgentPage dispatcherName={profile.dispatcher_name} />}
          </>
        }
      />
    </Routes>
  ) : (
    <Routes location={location}>
      <Route path="/dispatcher/:name" element={<DispatcherDetailPage />} />
      <Route path="/proposals/:id" element={<ProposalDetailPage />} />
      <Route
        path="*"
        element={
          <>
            {tab === 'work_orders' && <WorkOrdersPage role={profile.role} />}
            {tab === 'kpi' && <KPIOverviewPage />}
            {tab === 'analytics' && <AnalyticsPage />}
            {tab === 'map' && <MapPage />}
            {tab === 'proposals' && (
              <ProposalsPage role={profile.role} dispatcherName={profile.dispatcher_name} />
            )}
            {tab === 'price_lists' && <PriceListsPage />}
            {tab === 'dispatch_agent' && <DispatchAgentPage />}
            {tab === 'users' && profile.role === 'super_admin' && <ManageUsersPage />}
            {tab === 'clients' && profile.role === 'super_admin' && <ClientReportsPage />}
          </>
        }
      />
    </Routes>
  )

  return (
    <div className="min-h-screen bg-canvas md:flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 border-r border-line bg-white">
        <BrandMark />
        <div className="flex-1 overflow-y-auto px-3 py-2">{sidebarBody}</div>
        <UserCard name={profile.display_name} role={profile.role} onSignOut={signOut} />
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
              <UserCard name={profile.display_name} role={profile.role} onSignOut={signOut} />
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

function UserCard({ name, role, onSignOut }: { name: string; role: string; onSignOut: () => void }) {
  return (
    <div className="border-t border-line-soft px-3 py-3 flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-full bg-brand-50 text-brand-700 font-bold text-xs flex items-center justify-center shrink-0">
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink truncate">{name}</p>
        <p className="text-xs text-ink-faint capitalize">{role.replace('_', ' ')}</p>
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
