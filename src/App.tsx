import { useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { LayoutGrid, ClipboardList, Users, Building2, LogOut, BarChart3, Map as MapIcon, FileText, Tags } from 'lucide-react'
import { useAuth } from './hooks/useAuth'
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

type Tab = 'work_orders' | 'kpi' | 'analytics' | 'map' | 'users' | 'clients' | 'proposals' | 'price_lists'
type DispatcherTab = 'jobs' | 'proposals' | 'price_lists'

export default function App() {
  const { session, profile, loading, error, signIn, signOut } = useAuth()
  const [tab, setTab] = useState<Tab>('work_orders')
  const [dispatcherTab, setDispatcherTab] = useState<DispatcherTab>('jobs')
  const navigate = useNavigate()

  const goTab = (t: Tab) => {
    setTab(t)
    navigate('/')
  }

  const goDispatcherTab = (t: DispatcherTab) => {
    setDispatcherTab(t)
    navigate('/')
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-gray-400">Loading...</div>
  }

  if (!session) {
    return <LoginPage signIn={signIn} error={error} />
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm text-center space-y-4">
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-4">{error || 'No profile found for this account.'}</p>
          <button onClick={signOut} className="text-sm font-medium text-gray-500 hover:text-gray-700">Sign out</button>
        </div>
      </div>
    )
  }

  const isDispatcherOnly = profile.role === 'dispatcher'

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase">New Global Vista Solutions</p>
            <h1 className="text-lg font-bold text-gray-900">Dispatcher KPI Platform</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium text-gray-900">{profile.display_name}</p>
              <p className="text-xs text-gray-400 capitalize">{profile.role.replace('_', ' ')}</p>
            </div>
            <button onClick={signOut} className="text-gray-400 hover:text-red-600" title="Sign out">
              <LogOut size={18} />
            </button>
          </div>
        </div>
        {!isDispatcherOnly && (
          <nav className="max-w-6xl mx-auto px-6 flex gap-1 -mb-px">
            <NavTab active={tab === 'work_orders'} onClick={() => goTab('work_orders')} icon={<ClipboardList size={15} />} label="Work Orders" />
            <NavTab active={tab === 'kpi'} onClick={() => goTab('kpi')} icon={<LayoutGrid size={15} />} label="KPI Overview" />
            <NavTab active={tab === 'analytics'} onClick={() => goTab('analytics')} icon={<BarChart3 size={15} />} label="Analytics" />
            <NavTab active={tab === 'map'} onClick={() => goTab('map')} icon={<MapIcon size={15} />} label="Map" />
            <NavTab active={tab === 'proposals'} onClick={() => goTab('proposals')} icon={<FileText size={15} />} label="Proposals" />
            <NavTab active={tab === 'price_lists'} onClick={() => goTab('price_lists')} icon={<Tags size={15} />} label="Price Lists" />
            {profile.role === 'super_admin' && (
              <NavTab active={tab === 'users'} onClick={() => goTab('users')} icon={<Users size={15} />} label="Manage Users" />
            )}
            {profile.role === 'super_admin' && (
              <NavTab active={tab === 'clients'} onClick={() => goTab('clients')} icon={<Building2 size={15} />} label="Store Reports" />
            )}
          </nav>
        )}
        {isDispatcherOnly && (
          <nav className="max-w-6xl mx-auto px-6 flex gap-1 -mb-px">
            <NavTab active={dispatcherTab === 'jobs'} onClick={() => goDispatcherTab('jobs')} icon={<ClipboardList size={15} />} label="My Jobs" />
            <NavTab active={dispatcherTab === 'proposals'} onClick={() => goDispatcherTab('proposals')} icon={<FileText size={15} />} label="Proposals" />
            <NavTab active={dispatcherTab === 'price_lists'} onClick={() => goDispatcherTab('price_lists')} icon={<Tags size={15} />} label="Price Lists" />
          </nav>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {isDispatcherOnly ? (
          <Routes>
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
                </>
              }
            />
          </Routes>
        ) : (
          <Routes>
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
                  {tab === 'users' && profile.role === 'super_admin' && <ManageUsersPage />}
                  {tab === 'clients' && profile.role === 'super_admin' && <ClientReportsPage />}
                </>
              }
            />
          </Routes>
        )}
      </main>
    </div>
  )
}

function NavTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2.5 border-b-2 transition-colors ${
        active ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {icon} {label}
    </button>
  )
}
