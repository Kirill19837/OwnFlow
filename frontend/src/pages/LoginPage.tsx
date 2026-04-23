import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import { Layers, Mail } from 'lucide-react'

const MAGIC_LINK_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

function getMagicLinkCooldownRemaining(email: string): number {
  try {
    const raw = localStorage.getItem(`ml_sent_${email}`)
    if (!raw) return 0
    const sentAt = parseInt(raw, 10)
    const elapsed = Date.now() - sentAt
    return Math.max(0, MAGIC_LINK_COOLDOWN_MS - elapsed)
  } catch {
    return 0
  }
}

function formatMinutes(ms: number) {
  return Math.ceil(ms / 60_000)
}

export default function LoginPage() {
  const { signIn, signUp, session } = useAuthStore()
  const navigate = useNavigate()

  // Already logged in → go to app
  useEffect(() => {
    if (session) navigate('/', { replace: true })
  }, [session, navigate])

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [signedUpEmail, setSignedUpEmail] = useState<string | null>(null)

  // Magic link state
  const [showMagicLink, setShowMagicLink] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [magicLinkLoading, setMagicLinkLoading] = useState(false)
  const [magicLinkCooldown, setMagicLinkCooldown] = useState(0)

  // Refresh cooldown display every minute
  useEffect(() => {
    if (!showMagicLink) return
    const refresh = () => setMagicLinkCooldown(getMagicLinkCooldownRemaining(email))
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [showMagicLink, email])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setShowMagicLink(false)
    setMagicLinkSent(false)
    setLoading(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
        navigate('/')
      } else {
        await signUp(email, password, name)
        setSignedUpEmail(email)
      }
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'Something went wrong'
      setError(msg)
      // Detect wrong-password / invalid credentials → offer magic link
      if (mode === 'login' && /invalid|credentials|password|incorrect/i.test(msg)) {
        setShowMagicLink(true)
        setMagicLinkCooldown(getMagicLinkCooldownRemaining(email))
      }
    } finally {
      setLoading(false)
    }
  }

  const sendMagicLink = async () => {
    if (magicLinkCooldown > 0 || magicLinkLoading) return
    setMagicLinkLoading(true)
    try {
      await api.post('/auth/magic-link', { email })
      localStorage.setItem(`ml_sent_${email}`, String(Date.now()))
      setMagicLinkCooldown(MAGIC_LINK_COOLDOWN_MS)
      setMagicLinkSent(true)
    } catch {
      // Still show success to avoid user enumeration
      setMagicLinkSent(true)
    } finally {
      setMagicLinkLoading(false)
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
                  onClick={() => { setMode(m); setError(''); setName('') }}
                  className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    mode === m ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {m === 'login' ? 'Sign in' : 'Sign up'}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="space-y-4">
              {mode === 'signup' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Full name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Smith"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
                  />
                </div>
              )}
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

              {showMagicLink && (
                <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3 text-sm">
                  {magicLinkSent ? (
                    <p className="text-purple-300">
                      Magic link sent to <strong>{email}</strong> — check your inbox.
                    </p>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-gray-400">Trouble signing in?</span>
                      {magicLinkCooldown > 0 ? (
                        <span className="text-gray-500 text-xs">
                          Try again in {formatMinutes(magicLinkCooldown)} min
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={sendMagicLink}
                          disabled={magicLinkLoading}
                          className="text-purple-400 hover:text-purple-300 font-medium disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          {magicLinkLoading ? 'Sending…' : 'Send magic link'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
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
