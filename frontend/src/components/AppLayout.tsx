import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useTeamStore } from '../store/teamStore'
import { useCompanyStore } from '../store/companyStore'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import type { Company, Team } from '../types'
import { LogOut, Layers, ChevronDown, Plus, Settings, Building2, Sun, Moon, UserCircle } from 'lucide-react'
import CompleteProfileModal from './CompleteProfileModal'
import SelectSkillsModal from './SelectSkillsModal'
import { useThemeStore } from '../store/themeStore'

export default function AppLayout() {
  const { signOut, session, needsPassword, needsName, needsSkills, linkType } = useAuthStore()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const { teams, activeTeam, setTeams, setActiveTeam } = useTeamStore()
  const { company, setCompany } = useCompanyStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dropOpen, setDropOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)
  const lastUserIdRef = useRef<string | null>(null)

  // Fetch company
  const { data: companyData, isSuccess: companyLoaded } = useQuery({
    queryKey: ['company', session?.user.id],
    queryFn: () =>
      api.get<Company | null>('/companies/my', { params: { user_id: session!.user.id } }).then((r) => r.data),
    enabled: !!session,
  })

  useEffect(() => {
    if (!companyLoaded) return
    setCompany(companyData ?? null)
  }, [companyData, companyLoaded, setCompany])

  // Fetch teams (scoped to company if available, else legacy /orgs/my)
  const { data: teamsData } = useQuery({
    queryKey: ['teams', companyData?.id ?? 'legacy', session?.user.id],
    queryFn: () =>
      companyData
        ? api.get<Team[]>(`/companies/${companyData.id}/teams`, { params: { user_id: session!.user.id } }).then((r) => r.data)
        : api.get<Team[]>('/teams/my', { params: { user_id: session!.user.id } }).then((r) => r.data),
    enabled: !!session && companyLoaded,
  })

  // Clear state on user switch
  useEffect(() => {
    const currentUserId = session?.user.id ?? null
    if (lastUserIdRef.current && lastUserIdRef.current !== currentUserId) {
      setTeams([])
      setActiveTeam(null)
      setCompany(null)
    }
    lastUserIdRef.current = currentUserId
  }, [session?.user.id, setTeams, setActiveTeam, setCompany])

  // Sync teams into store; redirect to company setup if nothing exists
  const { mutate: createDefaultTeamMutate, isPending: isCreatingDefaultTeam } = useMutation({
    mutationFn: async () => {
      const emailPrefix = session?.user.email?.split('@')[0]?.trim() || 'My'
      const first = emailPrefix[0]?.toUpperCase() || 'M'
      const name = `${first}${emailPrefix.slice(1)} Team`
      const { data } = await api.post<Team>('/teams', {
        name,
        owner_id: session!.user.id,
        default_ai_model: 'gpt-4o',
      })
      return data
    },
    onSuccess: (team) => {
      setTeams([team])
      setActiveTeam(team)
      queryClient.setQueryData(['teams', 'legacy', session?.user.id], [team])
    },
  })

  const autoCreateAttemptRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamsData || !session?.user.id || !companyLoaded) return
    setTeams(teamsData)
    // Auto-select first team if nothing is active yet
    if (teamsData.length > 0 && !activeTeam) {
      setActiveTeam(teamsData[0])
      return
    }
    if (teamsData.length > 0) return
    // Don't redirect while the profile-completion modal is still open
    if (needsPassword || needsName) return
    // Don't redirect if the user is in the middle of an invite acceptance flow —
    // their company membership is being created right now.
    if (linkType === 'join_company') return
    // No teams and no company → send to company setup
    if (!companyData) {
      navigate('/company/new')
      return
    }
    // Has company but no teams yet → auto-create a default team (edge case)
    if (autoCreateAttemptRef.current !== session.user.id && !isCreatingDefaultTeam) {
      autoCreateAttemptRef.current = session.user.id
      createDefaultTeamMutate()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamsData, session?.user.id, companyLoaded])

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
    setTeams([])
    setActiveTeam(null)
    setCompany(null)
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between gap-4">
        <NavLink to="/" className="flex items-center gap-2 font-bold text-lg text-purple-400 shrink-0">
          <Layers size={20} />
          OwnFlow
        </NavLink>

        {/* Company name */}
        {company && (
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-gray-500">
            <Building2 size={12} />
            <span>{company.name}</span>
          </div>
        )}

        {/* Team switcher */}
        <div className="relative" ref={dropRef}>
          <button
            onClick={() => setDropOpen((p) => !p)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-white transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="max-w-[140px] truncate">{activeTeam?.name ?? 'Select team'}</span>
            <ChevronDown size={14} className="text-gray-400" />
          </button>

          {dropOpen && (
            <div className="absolute left-0 top-full mt-1 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
              {teams.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setActiveTeam(t); setDropOpen(false) }}
                  className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-gray-800 transition-colors ${
                    activeTeam?.id === t.id ? 'text-purple-300' : 'text-gray-200'
                  }`}
                >
                  <span className="flex-1 truncate">{t.name}</span>
                  <span className="text-xs text-gray-600 capitalize">{t.my_role}</span>
                </button>
              ))}
              <div className="border-t border-gray-800">
                <button
                  onClick={() => { navigate('/teams/new'); setDropOpen(false) }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                >
                  <Plus size={14} />
                  New team
                </button>
                {activeTeam && (
                  <button
                    onClick={() => { navigate(`/teams/${activeTeam.id}/settings`); setDropOpen(false) }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                  >
                    <Settings size={14} />
                    Team settings
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-gray-400 ml-auto">
          <button
            onClick={() => navigate('/profile')}
            className="hidden sm:flex items-center gap-1.5 hover:text-white transition-colors"
            title="Profile"
          >
            <UserCircle size={15} />
            <span>{session?.user?.user_metadata?.full_name || session?.user.email}</span>
          </button>
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button onClick={handleSignOut} className="flex items-center gap-1 hover:text-white transition-colors">
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
      {(needsPassword || needsName) && linkType !== 'join_company' && <CompleteProfileModal />}
      {needsSkills && <SelectSkillsModal />}
    </div>
  )
}
