import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useCompanyStore } from '../store/companyStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import { supabase } from '../lib/supabase'
import {
  Layers,
  Bot,
  GitBranch,
  MessageSquare,
  Zap,
  ChevronRight,
  Phone,
  Building2,
  Star,
} from 'lucide-react'
import type { Team } from '../types'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o', sub: 'OpenAI · Best overall' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', sub: 'OpenAI · Fast & cheap' },
  { value: 'o3-mini', label: 'o3-mini', sub: 'OpenAI · Reasoning' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', sub: 'Anthropic · Top quality' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', sub: 'Anthropic · Ultra-fast' },
]

const PERKS = [
  {
    icon: Bot,
    title: 'AI actors that actually work',
    body: 'Autonomous agents plan sprints, break down tasks, and push code — so your team focuses on what matters.',
  },
  {
    icon: GitBranch,
    title: 'GitHub-native workflow',
    body: 'Sync issues, PRs, and branches in real time. OwnFlow lives inside your existing Git flow.',
  },
  {
    icon: MessageSquare,
    title: 'Real-time collaboration',
    body: 'Activity feed, live comments, and instant updates keep everyone aligned without standups.',
  },
  {
    icon: Zap,
    title: 'Early-access advantage',
    body: "You're among the first. Your feedback directly shapes the roadmap — features you need get built first.",
  },
]

export default function NewCompanyPage() {
  const { session, pendingProfile, setPendingProfile, setNeedsPassword, setNeedsName } = useAuthStore()
  const { setCompany } = useCompanyStore()
  const { setTeams, setActiveTeam } = useTeamStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Guard: if the user already belongs to a company, send them to the dashboard.
  // This prevents invited members from creating duplicate companies.
  const { data: existingCompany, isSuccess: companyChecked } = useQuery({
    queryKey: ['company', session?.user.id],
    queryFn: () =>
      api.get<{ id: string } | null>('/companies/my', { params: { user_id: session!.user.id } }).then((r) => r.data),
    enabled: !!session,
  })
  useEffect(() => {
    if (companyChecked && existingCompany) navigate('/', { replace: true })
  }, [existingCompany, companyChecked, navigate])

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [model, setModel] = useState('gpt-4o')

  const canSubmit = name.trim().length > 0 && phone.trim().length > 0

  const create = useMutation({
    mutationFn: async () => {
      // Set password client-side first — supabase.auth.updateUser keeps the
      // session alive. Never send the password to the backend (admin.update_user_by_id
      // revokes all tokens and logs the user out).
      if (pendingProfile?.password) {
        const { error } = await supabase.auth.updateUser({ password: pendingProfile.password })
        if (error) throw new Error(`Failed to set password: ${error.message}`)
      }
      return api
        .post('/companies', {
          name: name.trim(),
          owner_id: session!.user.id,
          default_ai_model: model,
          phone: phone.trim(),
          ...(pendingProfile?.name ? { full_name: pendingProfile.name } : {}),
        })
        .then((r) => r.data)
    },
    onSuccess: async (data) => {
      // Profile is now saved in Supabase — clear the pending state
      setPendingProfile(null)
      setNeedsPassword(false)
      setNeedsName(false)
      // Seed the company cache so AppLayout sees the real company immediately
      queryClient.setQueryData(['company', session!.user.id], data)
      setCompany(data)
      if (data.default_team_id) {
        const team: Team = {
          id: data.default_team_id,
          name: data.name,
          slug: `${data.slug}-team`,
          owner_id: data.owner_id,
          company_id: data.id,
          default_ai_model: model,
          created_at: data.created_at,
          my_role: 'owner',
        }
        setTeams([team])
        setActiveTeam(team)
      }
      navigate('/')
    },
  })

  return (
    <div className="min-h-screen bg-gray-950 flex">
      {/* ── Left panel: value prop ── */}
      <div className="hidden lg:flex flex-col justify-between w-[44%] bg-gradient-to-br from-purple-950 via-gray-950 to-gray-950 border-r border-gray-800 px-12 py-14">
        <div className="flex items-center gap-2 text-purple-400 font-bold text-lg">
          <Layers size={20} />
          OwnFlow
        </div>

        <div className="space-y-10">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-purple-400 bg-purple-900/30 border border-purple-800/50 rounded-full px-3 py-1 mb-4">
              <Star size={11} fill="currentColor" /> Early access
            </div>
            <h1 className="text-4xl font-bold text-white leading-tight mb-4">
              The AI-powered<br />project OS for<br />engineering teams
            </h1>
            <p className="text-gray-400 text-base leading-relaxed">
              OwnFlow replaces your task tracker, sprint planner, and standup bot with
              autonomous AI actors that actually close tickets.
            </p>
          </div>

          <div className="space-y-6">
            {PERKS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-4">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-purple-900/40 border border-purple-800/40 flex items-center justify-center">
                  <Icon size={16} className="text-purple-400" />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">{title}</p>
                  <p className="text-gray-500 text-sm mt-0.5 leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-gray-700 text-xs">
          © {new Date().getFullYear()} OwnFlow · All rights reserved
        </p>
      </div>

      {/* ── Right panel: form ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-14">
        {/* Mobile logo */}
        <div className="flex lg:hidden items-center gap-2 text-purple-400 font-bold text-lg mb-8">
          <Layers size={20} />
          OwnFlow
        </div>

        <div className="w-full max-w-md">
          <h2 className="text-2xl font-bold text-white mb-1">Set up your workspace</h2>
          <p className="text-gray-400 text-sm mb-8">
            You're getting <span className="text-white font-medium">free access</span> while we're in early access.
            In return we ask for a phone number so we can reach you for a quick feedback call — usually 15 min, always optional.
          </p>

          <div className="space-y-5">
            {/* Company name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Company name <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <Building2 size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Acme Corp"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent placeholder-gray-600"
                />
              </div>
            </div>

            {/* Phone */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Phone number <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <Phone size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="tel"
                  placeholder="+1 555 000 0000"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent placeholder-gray-600"
                />
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                We'll only call to gather feedback. No spam, no sales — ever.
              </p>
            </div>

            {/* AI model */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Default AI model</label>
              <p className="text-xs text-gray-500 mb-2">Powers task breakdown and AI actors across all your projects. Can be changed later.</p>
              <div className="grid grid-cols-1 gap-1.5">
                {AI_MODELS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setModel(m.value)}
                    className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg border text-left transition-all ${
                      model === m.value
                        ? 'border-purple-500 bg-purple-900/25 text-white'
                        : 'border-gray-800 text-gray-400 hover:border-gray-600 hover:bg-gray-900'
                    }`}
                  >
                    <div>
                      <span className="text-sm font-medium">{m.label}</span>
                      <span className="text-xs text-gray-500 ml-2">{m.sub}</span>
                    </div>
                    <div className={`w-4 h-4 rounded-full border-2 shrink-0 transition-all ${
                      model === m.value ? 'border-purple-500 bg-purple-500' : 'border-gray-600'
                    }`} />
                  </button>
                ))}
              </div>
            </div>

            {create.isError && (
              <p className="text-red-400 text-sm">Something went wrong. Please try again.</p>
            )}

            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={!canSubmit || create.isPending}
              className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-colors mt-2"
            >
              {create.isPending ? (
                'Creating workspace…'
              ) : (
                <>
                  Create workspace
                  <ChevronRight size={16} />
                </>
              )}
            </button>

            <p className="text-center text-xs text-gray-600">
              By continuing you agree to our{' '}
              <a href="#" className="text-gray-500 underline underline-offset-2">Terms</a> and{' '}
              <a href="#" className="text-gray-500 underline underline-offset-2">Privacy Policy</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
