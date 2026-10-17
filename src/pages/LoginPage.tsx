import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase">New Global Vista Solutions</p>
          <h1 className="text-xl font-bold text-gray-900 mt-1">Dispatcher KPI Platform</h1>
        </div>
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <p className="text-sm font-semibold text-gray-700">Sign in to your dashboard</p>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg py-2.5 transition-colors disabled:opacity-60"
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
          <p className="text-xs text-gray-400 text-center pt-2">
            Real accounts only — a Super Admin creates your login from Manage Users.
          </p>
        </form>
      </div>
    </div>
  )
}

export type UseAuthReturn = ReturnType<typeof useAuth>
