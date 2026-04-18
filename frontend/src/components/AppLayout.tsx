import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useOrgStore } from '../store/orgStore'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import type { Organization } from '../types'
import { LogOut, Layers, ChevronDown, Plus, Settings } from 'lucide-react'

export default function AppLayout() {
  const { signOut, session } = useAuthStore()
  const { orgs, activeOrg, setOrgs, setActiveOrg } = useOrgStore()
  const navigate = useNavigate()
  const [dropOpen, setDropOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['orgs', session?.user.id],
    queryFn: () =>
      api.get<Organization[]>('/orgs/my', { params: { user_id: session!.user.id } }).then((r) => r.data),
    enabled: !!session,
  })

  useEffect(() => {
    if (data) setOrgs(data)
  }, [data])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between gap-4">
        <NavLink to="/" className="flex items-center gap-2 font-bold text-lg text-purple-400 shrink-0">
          <Layers size={20} />
          OwnFlow
        </NavLink>

        {/* Org switcher */}
        <div className="relative" ref={dropRef}>
          <button
            onClick={() => setDropOpen((p) => !p)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-white transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="max-w-[140px] truncate">{activeOrg?.name ?? 'Select org'}</span>
            <ChevronDown size={14} className="text-gray-400" />
          </button>

          {dropOpen && (
            <div className="absolute left-0 top-full mt-1 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
              {orgs.map((o) => (
                <button
                  key={o.id}
                  onClick={() => { setActiveOrg(o); setDropOpen(false) }}
                  className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-gray-800 transition-colors ${
                    activeOrg?.id === o.id ? 'text-purple-300' : 'text-gray-200'
                  }`}
                >
                  <span className="flex-1 truncate">{o.name}</span>
                  <span className="text-xs text-gray-600 capitalize">{o.my_role}</span>
                </button>
              ))}
              <div className="border-t border-gray-800">
                <button
                  onClick={() => { navigate('/orgs/new'); setDropOpen(false) }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                >
                  <Plus size={14} />
                  New organization
                </button>
                {activeOrg && (
                  <button
                    onClick={() => { navigate(`/orgs/${activeOrg.id}/settings`); setDropOpen(false) }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                  >
                    <Settings size={14} />
                    Org settings
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-gray-400 ml-auto">
          <span className="hidden sm:block">{session?.user.email}</span>
          <button onClick={handleSignOut} className="flex items-center gap-1 hover:text-white transition-colors">
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  )
}
