import { Fragment, useEffect, useState } from 'react'
import { Loader2, Lock, Trash2, UserPlus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useProfiles } from '../hooks/useProfiles'
import { useEntities } from '../hooks/useEntities'
import { useEntityScope } from '../contexts/EntityScopeContext'
import { Button, PageHeader } from '../components/ui'
import type { Role } from '../lib/types'

const DEFAULT_FORM = { email: '', password: '', role: 'dispatcher' as Role, displayName: '', dispatcherName: '', entityId: '' }

export function ManageUsersPage() {
  const { profiles, refetch, updateScorecard, updateEntity, updateRole, updateDispatcherName, deleteProfile } = useProfiles()
  const { entities } = useEntities()
  const { activeEntityId } = useEntityScope()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<{ error?: string; success?: string } | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [roleErr, setRoleErr] = useState<{ id: string; message: string } | null>(null)
  const [pwRowId, setPwRowId] = useState<string | null>(null)
  const [pwValue, setPwValue] = useState('')
  const [pwSubmitting, setPwSubmitting] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ id: string; error?: string; success?: string } | null>(null)

  // Default the new-user form to whichever entity is currently active in the
  // sidebar switcher -- still a deliberate choice, since it can be changed
  // before creating, but it saves re-picking the common case.
  useEffect(() => {
    setForm((f) => (f.entityId ? f : { ...f, entityId: activeEntityId }))
  }, [activeEntityId])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null))
  }, [])

  const handleRoleChange = async (profile: { id: string; display_name: string; role: Role }, next: Role) => {
    setRoleErr(null)
    if (profile.id === currentUserId && profile.role === 'super_admin' && next !== 'super_admin') {
      if (!confirm(`This removes your own Super Admin access -- you won't be able to undo it yourself. Continue?`)) {
        return
      }
    }
    try {
      await updateRole(profile.id, next)
    } catch (err) {
      setRoleErr({ id: profile.id, message: (err as Error).message || String(err) })
    }
  }

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

  const togglePasswordRow = (id: string) => {
    setPwMsg(null)
    setPwValue('')
    setPwRowId((cur) => (cur === id ? null : id))
  }

  const handleSetPassword = async (p: { id: string; display_name: string }) => {
    setPwMsg(null)
    if (pwValue.length < 8) {
      setPwMsg({ id: p.id, error: 'Password must be at least 8 characters.' })
      return
    }
    setPwSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const { data, error } = await supabase.functions.invoke('admin-update-user-password', {
        body: { userId: p.id, newPassword: pwValue },
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      })
      if (error) {
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
      setPwMsg({ id: p.id, success: `Password updated for ${p.display_name}.` })
      setPwValue('')
    } catch (err) {
      setPwMsg({ id: p.id, error: (err as Error).message || String(err) })
    } finally {
      setPwSubmitting(false)
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
              <Fragment key={p.id}>
              <tr className="table-row">
                <td className="px-4 py-2.5 text-ink font-medium">
                  {p.display_name}
                  {p.id === currentUserId && <span className="text-ink-faint"> (you)</span>}
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={p.role}
                    onChange={(e) => handleRoleChange(p, e.target.value as Role)}
                    className="field py-1 text-sm"
                  >
                    <option value="dispatcher">Dispatcher</option>
                    <option value="data_entry">Data Entry</option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                  {roleErr?.id === p.id && <p className="text-xs text-danger mt-1">{roleErr.message}</p>}
                </td>
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
                <td className="px-4 py-2.5">
                  <TextInput
                    value={p.dispatcher_name}
                    placeholder={p.role === 'dispatcher' ? 'Must match work orders' : '—'}
                    onBlur={(v) => updateDispatcherName(p.id, v)}
                  />
                </td>
                <td className="px-4 py-2.5">
                  <ScoreInput value={p.app_ivr} onBlur={(v) => updateScorecard(p.id, v, p.system_usage ?? 0)} />
                </td>
                <td className="px-4 py-2.5">
                  <ScoreInput value={p.system_usage} onBlur={(v) => updateScorecard(p.id, p.app_ivr ?? 0, v)} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => togglePasswordRow(p.id)} className="text-ink-faint hover:text-brand transition-colors" title="Change password">
                      <Lock size={14} />
                    </button>
                    <button onClick={() => handleRemove(p.id, p.display_name)} className="text-ink-faint hover:text-danger transition-colors" title="Remove login">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
              {pwRowId === p.id && (
                <tr className="table-row bg-canvas">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        autoFocus
                        value={pwValue}
                        onChange={(e) => setPwValue(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSetPassword(p)}
                        placeholder={`New password for ${p.display_name} (8+ characters)`}
                        className="field py-1 text-sm w-72"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        icon={pwSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                        disabled={pwSubmitting}
                        onClick={() => handleSetPassword(p)}
                      >
                        {pwSubmitting ? 'Setting...' : 'Set Password'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => togglePasswordRow(p.id)}>
                        Cancel
                      </Button>
                    </div>
                    {pwMsg?.id === p.id && pwMsg.error && <p className="text-xs text-danger mt-2">{pwMsg.error}</p>}
                    {pwMsg?.id === p.id && pwMsg.success && <p className="text-xs text-good mt-2">{pwMsg.success}</p>}
                  </td>
                </tr>
              )}
              </Fragment>
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

function TextInput({ value, placeholder, onBlur }: { value: string | null; placeholder?: string; onBlur: (v: string) => void }) {
  const [local, setLocal] = useState(value ?? '')
  return (
    <input
      type="text"
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onBlur(local.trim())}
      className="field py-1 text-sm w-40"
    />
  )
}
