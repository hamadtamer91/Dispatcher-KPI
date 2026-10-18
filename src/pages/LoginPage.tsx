import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui'

export function LoginPage({ signIn, error }: { signIn: (email: string, password: string) => Promise<boolean>; error: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    await signIn(email, password)
    setSubmitting(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-11 h-11 rounded-xl bg-brand-600 text-white font-extrabold text-lg flex items-center justify-center mb-3">
            N
          </div>
          <h1 className="text-lg font-extrabold text-ink">NGVS Dispatch Console</h1>
          <p className="text-sm text-ink-faint mt-0.5">New Global Vista Solutions</p>
        </div>
        <form onSubmit={handleSubmit} className="panel p-6 space-y-4">
          <p className="text-sm font-bold text-ink">Sign in</p>
          <div>
            <label className="field-label">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
            />
          </div>
          <div>
            <label className="field-label">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field"
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" variant="primary" disabled={submitting} className="w-full">
            {submitting ? 'Signing in...' : 'Sign in'}
          </Button>
          <p className="text-xs text-ink-faint text-center pt-2">
            Real accounts only — a Super Admin creates your login from Manage Users.
          </p>
        </form>
      </div>
    </div>
  )
}

export type UseAuthReturn = ReturnType<typeof useAuth>
