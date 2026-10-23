import { useEffect, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useProfiles } from '../hooks/useProfiles'
import { useEntities } from '../hooks/useEntities'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { Button, PageHeader } from '../components/ui'
import type { Role } from '../lib/types'

const DEFAULT_FORM = { email: '', password: '', role: 'dispatcher' as Role, displayName: '', dispatcherName: '', entityId: '' }

export function ManageUsersPage() {
  const { profiles, refetch, updateScorecard, updateEntity, deleteProfile } = useProfiles()
  const { entities } = useEntities()
  const { activeEntityId } = useEntityScope()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<{ error?: string; success?: string } | null>(null)

  // Default the new-user form to whichever entity is currently active in the
  // sidebar switcher -- still a deliberate choice, since it can be changed
  // before creating, but it saves re-picking the common case.
  useEffect(() => {
    setForm((f) => (f.entityId ? f : { ...f, entityId: activeEntityId }))
  }, [activeEntityId])

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
    if (!form.entityId) {
      setMsg({ error: 'Select which entity this user works for.' })
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
          entityId: form.entityId,
        },
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      })
      if (error) {
        // supabase-js only parses the response body into `data` on a 2xx --
        // on a non-2xx it just gives this generic error and leaves the
        // function's real message (entityId missing, duplicate email,
        // caller not super_admin, etc) sitting unread on error.context.
        let message = error.message
        try {
          const ctx = (error as unknown as { context?: Response }).context
          if (ctx) {
            const body = await ctx.clone().json()
            if (body?.error) message = body.error
          }
        } catch {
          // fall back to error.message
        }
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      setMsg({ success: `User "${form.displayName}" created.` })
      setForm({ ...DEFAULT_FORM, entityId: activeEntityId })
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
      <PageHeader title="Manage Users" description="Create logins and track scorecard inputs for the team." />

      <div className="panel p-6">
        <p className="text-sm font-bold text-ink mb-4">Create New User</p>
        <div className="grid grid-cols-2 gap-4">
          <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="field" />
          <input placeholder="Password (8+ characters)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="field" />
          <input placeholder="Display Name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="field" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className="field">
            <option value="dispatcher">Dispatcher</option>
            <option value="data_entry">Data Entry</option>
            <option value="super_admin">Super Admin</option>
          </select>
          <select
            value={form.entityId}
            onChange={(e) => setForm({ ...form, entityId: e.target.value })}
            className="field col-span-2"
          >
            <option value="" disabled>Select entity...</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          {form.role === 'dispatcher' && (
            <input
              placeholder="Dispatcher name (must match work orders)"
              value={form.dispatcherName}
              onChange={(e) => setForm({ ...form, dispatcherName: e.target.value })}
              className="field col-span-2"
            />
          )}
        </div>
        {msg?.error && <p className="text-sm text-danger mt-3">{msg.error}</p>}
        {msg?.success && <p className="text-sm text-good mt-3">{msg.success}</p>}
        <Button
          variant="primary"
          size="sm"
          icon={<UserPlus size={14} />}
          onClick={handleCreate}
          disabled={submitting}
          className="mt-4"
        >
          {submitting ? 'Creating...' : 'Create User'}
        </Button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="table-head-row">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Entity</th>
              <th className="px-4 py-3">Dispatcher Name</th>
              <th className="px-4 py-3">App/IVR</th>
              <th className="px-4 py-3">System Usage</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} className="table-row">
                <td className="px-4 py-2.5 text-ink font-medium">{p.display_name}</td>
                <td className="px-4 py-2.5 text-ink-soft capitalize">{p.role.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2.5">
                  <select
                    value={p.entity_id}
                    onChange={(e) => updateEntity(p.id, e.target.value)}
                    className="field py-1 text-sm"
                  >
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-ink-soft">{p.dispatcher_name ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <ScoreInput value={p.app_ivr} onBlur={(v) => updateScorecard(p.id, v, p.system_usage ?? 0)} />
                </td>
                <td className="px-4 py-2.5">
                  <ScoreInput value={p.system_usage} onBlur={(v) => updateScorecard(p.id, p.app_ivr ?? 0, v)} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRemove(p.id, p.display_name)} className="text-ink-faint hover:text-danger transition-colors">
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
      className="field w-20 py-1"
    />
  )
}
