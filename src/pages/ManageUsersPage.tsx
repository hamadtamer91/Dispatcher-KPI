import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useProfiles } from '../hooks/useProfiles'
import type { Role } from '../lib/types'

const DEFAULT_FORM = { email: '', password: '', role: 'dispatcher' as Role, displayName: '', dispatcherName: '' }

export function ManageUsersPage() {
  const { profiles, refetch, updateScorecard, deleteProfile } = useProfiles()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<{ error?: string; success?: string } | null>(null)

  const handleCreate = async () => {
    setMsg(null)
    if (!form.email || !form.password || !form.displayName) {
      setMsg({ error: 'Email, password, and display name are required.' })
      return
    }
    if (form.password.length < 8) {
      setMsg({ error: 'Password must be at least 8 characters.' })
      return
    }
    setSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const { data, error } = await supabase.functions.invoke('admin-create-user', {
        body: {
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          displayName: form.displayName.trim(),
          dispatcherName: form.role === 'dispatcher' ? form.dispatcherName.trim() : null,
        },
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setMsg({ success: `User "${form.displayName}" created.` })
      setForm(DEFAULT_FORM)
      refetch()
    } catch (err) {
      setMsg({ error: (err as Error).message || String(err) })
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemove = async (id: string, name: string) => {
    if (confirm(`Remove ${name}'s login? They will no longer be able to sign in.`)) {
      await deleteProfile(id)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <p className="text-sm font-semibold text-gray-700 mb-4">Create New User</p>
        <div className="grid grid-cols-2 gap-4">
          <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} />
          <input placeholder="Password (8+ characters)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputCls} />
          <input placeholder="Display Name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className={inputCls} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className={inputCls}>
            <option value="dispatcher">Dispatcher</option>
            <option value="data_entry">Data Entry</option>
            <option value="super_admin">Super Admin</option>
          </select>
          {form.role === 'dispatcher' && (
            <input
              placeholder="Dispatcher name (must match work orders)"
              value={form.dispatcherName}
              onChange={(e) => setForm({ ...form, dispatcherName: e.target.value })}
              className={`${inputCls} col-span-2`}
            />
          )}
        </div>
        {msg?.error && <p className="text-sm text-red-600 mt-3">{msg.error}</p>}
        {msg?.success && <p className="text-sm text-emerald-600 mt-3">{msg.success}</p>}
        <button
          onClick={handleCreate}
          disabled={submitting}
          className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg px-4 py-2 disabled:opacity-60"
        >
          {submitting ? 'Creating...' : 'Create User'}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-semibold">Name</th>
              <th className="px-4 py-3 font-semibold">Role</th>
              <th className="px-4 py-3 font-semibold">Dispatcher Name</th>
              <th className="px-4 py-3 font-semibold">App/IVR</th>
              <th className="px-4 py-3 font-semibold">System Usage</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5 text-gray-700">{p.display_name}</td>
                <td className="px-4 py-2.5 text-gray-700">{p.role}</td>
                <td className="px-4 py-2.5 text-gray-700">{p.dispatcher_name ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <ScoreInput value={p.app_ivr} onBlur={(v) => updateScorecard(p.id, v, p.system_usage ?? 0)} />
                </td>
                <td className="px-4 py-2.5">
                  <ScoreInput value={p.system_usage} onBlur={(v) => updateScorecard(p.id, p.app_ivr ?? 0, v)} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRemove(p.id, p.display_name)} className="text-gray-400 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ScoreInput({ value, onBlur }: { value: number | null; onBlur: (v: number) => void }) {
  const [local, setLocal] = useState(String(value ?? ''))
  return (
    <input
      type="number"
      min={0}
      max={100}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onBlur(Number(local) || 0)}
      className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
    />
  )
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
