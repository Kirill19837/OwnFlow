
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Building2, Pencil, Check, Trash2, Key, Bot, Zap, Star, Rocket } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useCompanyStore } from '../store/companyStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import toast from 'react-hot-toast'

type Plan = 'free' | 'standard' | 'pro'
const PLAN_LIMITS: Record<Plan, number> = { free: 100, standard: 500, pro: 1000 }

const PLANS: {
  id: Plan
  label: string
  price: string
  priceNote: string
  icon: React.ReactNode
  activeClass: string
  idleClass: string
  badgeClass: string
  features: string[]
  limit: string
}[] = [
  {
    id: 'free',
    label: 'Free',
    price: '$0',
    priceNote: 'forever',
    icon: <Zap size={14} />,
    activeClass: 'border-gray-400 bg-gray-800/60',
    idleClass: 'border-gray-700 hover:border-gray-600 bg-gray-800/20',
    badgeClass: 'bg-gray-700 text-gray-300',
    limit: '100 AI requests / month',
    features: [
      'Up to 100 AI requests per month',
      '1 active project at a time',
      'Up to 3 actors per project',
      'Community support',
    ],
  },
  {
    id: 'standard',
    label: 'Standard',
    price: '$50',
    priceNote: '/ month',
    icon: <Star size={14} />,
    activeClass: 'border-purple-500 bg-purple-950/20',
    idleClass: 'border-gray-700 hover:border-purple-700 bg-gray-800/20',
    badgeClass: 'bg-purple-800 text-purple-200',
    limit: '500 AI requests / month',
    features: [
      'Up to 500 AI requests per month',
      'Unlimited active projects',
      'Up to 10 actors per project',
      'Priority email support',
      'Realtime collaboration',
    ],
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '$100',
    priceNote: '/ month',
    icon: <Rocket size={14} />,
    activeClass: 'border-amber-500 bg-amber-950/20',
    idleClass: 'border-gray-700 hover:border-amber-700 bg-gray-800/20',
    badgeClass: 'bg-amber-700 text-amber-100',
    limit: '1000 AI requests / month',
    features: [
      'Up to 1000 AI requests per month',
      'Unlimited projects & actors',
      'Custom AI model configuration',
      'Dedicated Slack support',
      'Early access to new features',
      'SLA guarantee',
    ],
  },
]

function PlanBadge({ plan }: { plan: Plan }) {
  const p = PLANS.find(p => p.id === plan)!
  return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${p.badgeClass}`}>
      {p.icon}
        {p.label}
    </span>
  )
}

export default function CompanySettingsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { session } = useAuthStore()
  const { company, setCompany } = useCompanyStore()
  const { setTeams, setActiveTeam } = useTeamStore()

  const userId = session?.user?.id ?? ''
  const isOwner = !!company && company.owner_id === userId

  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingPhone, setEditingPhone] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingOpenAI, setEditingOpenAI] = useState(false)
  const [newOpenAIKey, setNewOpenAIKey] = useState('')
  const [editingAnthropic, setEditingAnthropic] = useState(false)
  const [newAnthropicKey, setNewAnthropicKey] = useState('')
  const [selectedPlan, setSelectedPlan] = useState<Plan>((company?.plan as Plan) ?? 'free')

  const currentPlan: Plan = (company?.plan as Plan) ?? 'free'
  const planChanged = selectedPlan !== currentPlan

  const rename = useMutation({
    mutationFn: (name: string) =>
        api.patch(`/companies/${company!.id}`, { name }, { params: { user_id: userId } }),
    onSuccess: (_, name) => {
      const updated = { ...company!, name }
      setCompany(updated)
      qc.setQueryData(['company', userId], updated)
      setRenaming(false)
      toast.success('Company renamed')
    },
    onError: () => toast.error('Failed to rename'),
  })

  const updatePhone = useMutation({
    mutationFn: (phone: string) =>
        api.patch(`/companies/${company!.id}`, { phone }, { params: { user_id: userId } }),
    onSuccess: (_, phone) => {
      const updated = { ...company!, phone }
      setCompany(updated)
      qc.setQueryData(['company', userId], updated)
      setEditingPhone(false)
      toast.success('Phone updated')
    },
    onError: () => toast.error('Failed to update phone'),
  })

  const updateOpenAIKey = useMutation({
    mutationFn: (openai_api_key: string) =>
        api.patch(`/companies/${company!.id}`, { openai_api_key }, { params: { user_id: userId } }),
    onSuccess: () => {
      setEditingOpenAI(false)
      setNewOpenAIKey('')
      qc.invalidateQueries({ queryKey: ['company', userId] })
      toast.success('OpenAI key saved')
    },
    onError: () => toast.error('Failed to save key'),
  })

  const updateAnthropicKey = useMutation({
    mutationFn: (anthropic_api_key: string) =>
        api.patch(`/companies/${company!.id}`, { anthropic_api_key }, { params: { user_id: userId } }),
    onSuccess: () => {
      setEditingAnthropic(false)
      setNewAnthropicKey('')
      qc.invalidateQueries({ queryKey: ['company', userId] })
      toast.success('Anthropic key saved')
    },
    onError: () => toast.error('Failed to save key'),
  })

  const updatePlan = useMutation({
    mutationFn: (plan: Plan) =>
        api.patch(`/companies/${company!.id}`, { plan }, { params: { user_id: userId } }),
    onSuccess: (_, plan) => {
      const updated = { ...company!, plan, ai_prompts_limit: PLAN_LIMITS[plan] }
      setCompany(updated)
      qc.setQueryData(['company', userId], updated)
      toast.success(`Switched to ${PLANS.find(p => p.id === plan)?.label} plan`)
    },
    onError: () => toast.error('Failed to update plan'),
  })

  const deleteCompany = useMutation({
    mutationFn: () =>
        api.delete(`/companies/${company!.id}`, { params: { user_id: userId } }),
    onSuccess: () => {
      setCompany(null)
      setTeams([])
      setActiveTeam(null)
      qc.removeQueries({ queryKey: ['company', userId] })
      qc.removeQueries({ queryKey: ['teams'] })
      navigate('/company/new', { replace: true })
    },
    onError: () => toast.error('Failed to delete company'),
  })

  if (!company) {
    return (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          No company found.
        </div>
    )
  }

  if (!isOwner) {
    return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-gray-400 mb-4">Only the company owner can access this page.</p>
            <button onClick={() => navigate('/')} className="text-purple-400 hover:text-purple-300 text-sm">
              ← Back to dashboard
            </button>
          </div>
        </div>
    )
  }

  return (
      <div className="max-w-2xl mx-auto w-full px-6 py-10">
        <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
        >
          <ChevronLeft size={16} /> Back
        </button>

        <div className="flex items-center gap-3 mb-8">
          <Building2 size={24} className="text-purple-400" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-white">{company.name}</h1>
              <PlanBadge plan={currentPlan} />
            </div>
            <p className="text-gray-500 text-sm">Company settings</p>
          </div>
        </div>

        <div className="space-y-6">

          {/* Rename */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-white mb-4">Company name</h2>
            {renaming ? (
                <div className="flex items-center gap-2">
                  <input
                      autoFocus
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newName.trim()) rename.mutate(newName.trim())
                        if (e.key === 'Escape') setRenaming(false)
                      }}
                      className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                  />
                  <button
                      onClick={() => newName.trim() && rename.mutate(newName.trim())}
                      disabled={!newName.trim() || rename.isPending}
                      className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
                  >
                    <Check size={14} /> Save
                  </button>
                  <button onClick={() => setRenaming(false)} className="text-sm text-gray-400 hover:text-white">
                    Cancel
                  </button>
                </div>
            ) : (
                <div className="flex items-center justify-between">
                  <span className="text-white">{company.name}</span>
                  <button
                      onClick={() => { setNewName(company.name); setRenaming(true) }}
                      className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    <Pencil size={13} /> Rename
                  </button>
                </div>
            )}
          </section>

          {/* Phone */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-white mb-4">Contact phone</h2>
            {editingPhone ? (
                <div className="flex items-center gap-2">
                  <input
                      autoFocus
                      type="tel"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newPhone.trim()) updatePhone.mutate(newPhone.trim())
                        if (e.key === 'Escape') setEditingPhone(false)
                      }}
                      className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                  />
                  <button
                      onClick={() => newPhone.trim() && updatePhone.mutate(newPhone.trim())}
                      disabled={!newPhone.trim() || updatePhone.isPending}
                      className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
                  >
                    <Check size={14} /> Save
                  </button>
                  <button onClick={() => setEditingPhone(false)} className="text-sm text-gray-400 hover:text-white">
                    Cancel
                  </button>
                </div>
            ) : (
                <div className="flex items-center justify-between">
                  <span className="text-white">{company.phone ?? <span className="text-gray-500 italic">Not set</span>}</span>
                  <button
                      onClick={() => { setNewPhone(company.phone ?? ''); setEditingPhone(true) }}
                      className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    <Pencil size={13} /> Edit
                  </button>
                </div>
            )}
          </section>

          {/* Plan */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-white mb-1">Subscription plan</h2>
            <p className="text-gray-500 text-xs mb-5">Choose the plan that fits your team's needs.</p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {PLANS.map((plan) => {
                const isSelected = selectedPlan === plan.id
                const isCurrent = currentPlan === plan.id
                return (
                    <button
                        key={plan.id}
                        onClick={() => setSelectedPlan(plan.id)}
                        className={`relative text-left rounded-xl border-2 p-4 transition-all ${isSelected ? plan.activeClass : plan.idleClass}`}
                    >
                      {isCurrent && (
                          <span className="absolute top-2 right-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-900 text-green-300">
                      current
                    </span>
                      )}
                      <div className={`flex items-center gap-1.5 mb-2 font-semibold text-sm ${
                          plan.id === 'pro' ? 'text-amber-300' : plan.id === 'standard' ? 'text-purple-300' : 'text-gray-300'
                      }`}>
                        {plan.icon}
                        {plan.label}
                      </div>
                      <div className="mb-3">
                        <span className="text-white text-xl font-bold">{plan.price}</span>
                        <span className="text-gray-500 text-xs ml-1">{plan.priceNote}</span>
                      </div>
                      <p className="text-xs text-gray-400 mb-3 font-medium">{plan.limit}</p>
                      <ul className="space-y-1">
                        {plan.features.map((f) => (
                            <li key={f} className="flex items-start gap-1.5 text-xs text-gray-400">
                              <Check size={11} className="mt-0.5 shrink-0 text-green-500" />
                              {f}
                            </li>
                        ))}
                      </ul>
                    </button>
                )
              })}
            </div>

            {planChanged && (
                <div className="mt-4 flex items-center gap-3">
                  <button
                      onClick={() => updatePlan.mutate(selectedPlan)}
                      disabled={updatePlan.isPending}
                      className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
                  >
                    <Check size={14} />
                    {updatePlan.isPending
                        ? 'Saving…'
                        : `Switch to ${PLANS.find(p => p.id === selectedPlan)?.label}`}
                  </button>
                  <button
                      onClick={() => setSelectedPlan(currentPlan)}
                      className="text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
            )}
          </section>

          {/* AI API Keys */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
            <h2 className="font-semibold text-white flex items-center gap-2">
              <Key size={15} className="text-purple-400" /> AI provider keys
            </h2>
            <p className="text-gray-500 text-xs -mt-2">
              These keys are used by built-in AI actors across all projects in your company.
            </p>

            {/* OpenAI */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">OpenAI API key</label>
              {editingOpenAI ? (
                  <div className="flex items-center gap-2">
                    <input
                        autoFocus
                        type="password"
                        value={newOpenAIKey}
                        onChange={(e) => setNewOpenAIKey(e.target.value)}
                        placeholder="sk-..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newOpenAIKey.trim()) updateOpenAIKey.mutate(newOpenAIKey.trim())
                          if (e.key === 'Escape') setEditingOpenAI(false)
                        }}
                        className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none"
                    />
                    <button
                        onClick={() => newOpenAIKey.trim() && updateOpenAIKey.mutate(newOpenAIKey.trim())}
                        disabled={!newOpenAIKey.trim() || updateOpenAIKey.isPending}
                        className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
                    >
                      <Check size={14} /> Save
                    </button>
                    <button onClick={() => setEditingOpenAI(false)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
                  </div>
              ) : (
                  <div className="flex items-center justify-between">
                <span className="text-sm text-white font-mono">
                  {company.openai_key_set
                      ? <span className="text-green-400">●&nbsp;Set</span>
                      : <span className="text-gray-500 italic font-sans">Not set</span>}
                </span>
                    <button
                        onClick={() => setEditingOpenAI(true)}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      <Pencil size={13} /> {company.openai_key_set ? 'Rotate' : 'Set key'}
                    </button>
                  </div>
              )}
            </div>

            {/* Anthropic */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">Anthropic API key</label>
              {editingAnthropic ? (
                  <div className="flex items-center gap-2">
                    <input
                        autoFocus
                        type="password"
                        value={newAnthropicKey}
                        onChange={(e) => setNewAnthropicKey(e.target.value)}
                        placeholder="sk-ant-..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newAnthropicKey.trim()) updateAnthropicKey.mutate(newAnthropicKey.trim())
                          if (e.key === 'Escape') setEditingAnthropic(false)
                        }}
                        className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none"
                    />
                    <button
                        onClick={() => newAnthropicKey.trim() && updateAnthropicKey.mutate(newAnthropicKey.trim())}
                        disabled={!newAnthropicKey.trim() || updateAnthropicKey.isPending}
                        className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
                    >
                      <Check size={14} /> Save
                    </button>
                    <button onClick={() => setEditingAnthropic(false)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
                  </div>
              ) : (
                  <div className="flex items-center justify-between">
                <span className="text-sm text-white font-mono">
                  {company.anthropic_key_set
                      ? <span className="text-green-400">●&nbsp;Set</span>
                      : <span className="text-gray-500 italic font-sans">Not set</span>}
                </span>
                    <button
                        onClick={() => setEditingAnthropic(true)}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      <Pencil size={13} /> {company.anthropic_key_set ? 'Rotate' : 'Set key'}
                    </button>
                  </div>
              )}
            </div>
          </section>

          {/* AI prompt usage */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-white mb-1">AI Usage</h2>
            <p className="text-gray-500 text-sm mb-4">
              Prompt usage across all projects in your company this billing period.
            </p>
            <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-300">
              {company.ai_prompts_used ?? 0} / {company.ai_prompts_limit ?? 100} prompts used
            </span>
              {(company.ai_prompts_used ?? 0) >= (company.ai_prompts_limit ?? 100) && (
                  <span className="text-xs text-red-400 bg-red-900/30 border border-red-800/50 px-2 py-0.5 rounded-full">
                Limit reached — upgrade your plan
              </span>
              )}
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                  className={`h-2 rounded-full transition-all ${
                      (company.ai_prompts_used ?? 0) >= (company.ai_prompts_limit ?? 100)
                          ? 'bg-red-500'
                          : (company.ai_prompts_used ?? 0) >= (company.ai_prompts_limit ?? 100) * 0.8
                              ? 'bg-yellow-500'
                              : 'bg-purple-500'
                  }`}
                  style={{
                    width: `${Math.min(100, ((company.ai_prompts_used ?? 0) / Math.max(1, (company.ai_prompts_limit ?? 100))) * 100)}%`
                  }}
              />
            </div>
          </section>

          {/* Agents shortcut */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-white flex items-center gap-2">
                  <Bot size={15} className="text-purple-400" /> Webhook agents
                </h2>
                <p className="text-gray-500 text-xs mt-1">Manage reusable external agents available across all projects.</p>
              </div>
              <button
                  onClick={() => navigate('/company/agents')}
                  className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg transition-colors"
              >
                <Bot size={13} /> Manage agents
              </button>
            </div>
          </section>

          {/* Delete */}
          <section className="bg-gray-900 border border-red-900/50 rounded-xl p-5">
            <h2 className="font-semibold text-red-400 mb-1 flex items-center gap-2">
              <Trash2 size={15} /> Delete company
            </h2>
            <p className="text-gray-500 text-sm mb-4">
              Permanently deletes the company, all its teams, memberships, and pending invites. This cannot be undone.
            </p>
            {!confirmDelete ? (
                <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 border border-red-800 rounded-lg hover:bg-red-900/30 transition-colors"
                >
                  <Trash2 size={14} /> Delete company
                </button>
            ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <p className="text-sm text-red-300">Are you sure? This is permanent and cannot be undone.</p>
                  <button
                      onClick={() => deleteCompany.mutate()}
                      disabled={deleteCompany.isPending}
                      className="px-3 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {deleteCompany.isPending ? 'Deleting…' : 'Yes, delete everything'}
                  </button>
                  <button
                      onClick={() => setConfirmDelete(false)}
                      className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
            )}
          </section>

        </div>
      </div>
  )
}
