import { useState } from 'react'
import { User } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../store/authStore'
import toast from 'react-hot-toast'

export default function SetNameModal() {
  const { setNeedsName, setSession } = useAuthStore()
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError('')
    setLoading(true)
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({
        data: { full_name: trimmed },
      })
      if (updateError) throw updateError
      // Sync the updated session so display name is immediately reflected
      if (data.user) {
        const { data: sessionData } = await supabase.auth.getSession()
        if (sessionData.session) setSession(sessionData.session)
      }
      setNeedsName(false)
      toast.success(`Welcome, ${trimmed}!`)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to save name')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-purple-900/40 border border-purple-800/40 flex items-center justify-center shrink-0">
            <User size={16} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-white font-semibold leading-tight">What's your name?</h2>
            <p className="text-gray-400 text-xs mt-0.5">
              We'll use this to personalise your experience and team activity.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Full name</label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Smith"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={!name.trim() || loading}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            {loading ? 'Saving…' : 'Save name & continue'}
          </button>
        </form>
      </div>
    </div>
  )
}
