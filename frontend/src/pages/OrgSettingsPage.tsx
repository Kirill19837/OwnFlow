import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useOrgStore } from '../store/orgStore'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import type { Organization } from '../types'
import { ChevronLeft, Settings, Trash2, UserPlus, Check } from 'lucide-react'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
  { value: 'o3-mini', label: 'o3-mini', provider: 'OpenAI' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', provider: 'Anthropic' },
]

export default function OrgSettingsPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { updateOrgModel } = useOrgStore()
  const { session } = useAuthStore()
  const [inviteId, setInviteId] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [saved, setSaved] = useState(false)

  const { data: org, isLoading } = useQuery({
    queryKey: ['org', orgId],
    queryFn: () => api.get<Organization>(`/orgs/${orgId}`).then((r) => r.data),
    enabled: !!orgId,
  })

  const updateModel = useMutation({
    mutationFn: (model: string) => api.patch(`/orgs/${orgId}`, { default_ai_model: model }),
    onSuccess: (_, model) => {
      updateOrgModel(orgId!, model)
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      qc.invalidateQueries({ queryKey: ['orgs'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const invite = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/members`, { user_id: inviteId, role: inviteRole }),
    onSuccess: () => {
      setInviteId('')
      qc.invalidateQueries({ queryKey: ['org', orgId] })
    },
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/orgs/${orgId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org', orgId] }),
  })

  if (isLoading || !org) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">Loading…</div>
  }

  return (
    <div className="max-w-2xl mx-auto w-full px-6 py-10">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors">
        <ChevronLeft size={16} /> Back
      </button>

      <div className="flex items-center gap-3 mb-8">
        <Settings size={24} className="text-purple-400" />
        <div>
          <h1 className="text-2xl font-bold text-white">{org.name}</h1>
          <p className="text-gray-500 text-sm">Organization settings</p>
        </div>
      </div>

      <div className="space-y-8">
        {/* Default AI model */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-1">Default AI Model</h2>
          <p className="text-gray-500 text-sm mb-4">
            All new projects in this org use this model unless overridden. You can switch between OpenAI and Anthropic here.
          </p>
          <div className="grid grid-cols-1 gap-2">
            {AI_MODELS.map((m) => (
              <button
                key={m.value}
                onClick={() => updateModel.mutate(m.value)}
                className={`flex items-center justify-between px-4 py-3 rounded-lg border transition-all text-left ${
                  org.default_ai_model === m.value
                    ? 'border-purple-500 bg-purple-900/30 text-white'
                    : 'border-gray-700 text-gray-300 hover:border-gray-500 hover:bg-gray-800'
                }`}
              >
                <div>
                  <span className="font-medium">{m.label}</span>
                  <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                    m.provider === 'OpenAI' ? 'bg-green-900/50 text-green-400' : 'bg-orange-900/50 text-orange-400'
                  }`}>{m.provider}</span>
                </div>
                {org.default_ai_model === m.value && (
                  <Check size={16} className="text-purple-400" />
                )}
              </button>
            ))}
          </div>
          {saved && <p className="text-green-400 text-sm mt-2">✓ Saved</p>}
        </section>

        {/* Members */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-4">Members</h2>
          <div className="space-y-2 mb-4">
            {(org.members ?? []).map((m) => (
              <div key={m.user_id} className="flex items-center justify-between px-3 py-2 bg-gray-800 rounded-lg">
                <div>
                  <p className="text-sm text-white font-mono">{m.user_id}</p>
                  <p className="text-xs text-gray-500 capitalize">{m.role}</p>
                </div>
                {m.user_id !== session?.user.id && (
                  <button
                    onClick={() => removeMember.mutate(m.user_id)}
                    className="text-gray-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Invite by user ID */}
          <div className="border-t border-gray-800 pt-4">
            <p className="text-sm text-gray-400 mb-2">Add member by Supabase user ID</p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="User UUID"
                value={inviteId}
                onChange={(e) => setInviteId(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as any)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm focus:outline-none"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={() => invite.mutate()}
                disabled={!inviteId.trim() || invite.isPending}
                className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                <UserPlus size={14} />
                Add
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
