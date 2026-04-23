import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { Layers, Mail } from 'lucide-react'

export default function LoginPage() {
  const { signIn, signUp } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [signedUpEmail, setSignedUpEmail] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
        navigate('/')
      } else {
        await signUp(email, password)
        setSignedUpEmail(email)
      }
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Layers size={36} className="text-purple-400 mb-2" />
          <h1 className="text-2xl font-bold text-white">OwnFlow</h1>
          <p className="text-gray-400 text-sm mt-1">Human-AI project orchestrator</p>
        </div>

        {signedUpEmail ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-purple-900/40 border border-purple-700/40 flex items-center justify-center mx-auto mb-4">
              <Mail size={22} className="text-purple-400" />
            </div>
            <h2 className="text-white font-semibold text-lg mb-2">Check your email</h2>
            <p className="text-gray-400 text-sm leading-relaxed mb-1">
              We sent a confirmation link to
            </p>
            <p className="text-white font-medium text-sm mb-4">{signedUpEmail}</p>
            <p className="text-gray-500 text-xs">
              Click the link in the email to activate your account, then come back here to sign in.
            </p>
            <button
              onClick={() => { setSignedUpEmail(null); setMode('login') }}
              className="mt-5 text-sm text-purple-400 hover:text-purple-300 transition-colors"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <div className="flex gap-2 mb-6">
              {(['login', 'signup'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setError('') }}
                  className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    mode === m ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {m === 'login' ? 'Sign in' : 'Sign up'}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium py-2 rounded-lg transition-colors"
              >
                {loading ? 'Loading…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
