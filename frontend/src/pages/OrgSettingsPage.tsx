import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTeamStore } from '../store/teamStore'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import type { Team, TeamPendingInvite, Skill } from '../types'
import { ChevronLeft, Settings, Trash2, UserPlus, Check, RotateCcw, Pencil } from 'lucide-react'

// Stable role UUIDs — match backend ROLE_IDS; use these for permission checks
const ROLE_IDS = {
  owner:  '00000000-0000-0000-0000-000000000001',
  admin:  '00000000-0000-0000-0000-000000000002',
  member: '00000000-0000-0000-0000-000000000003',
} as const

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
  { value: 'o3-mini', label: 'o3-mini', provider: 'OpenAI' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', provider: 'Anthropic' },
]

export default function OrgSettingsPage() {
  const { teamId } = useParams<{ teamId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { updateTeamModel } = useTeamStore()
  const { session } = useAuthStore()
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [inviteMessage, setInviteMessage] = useState('')
  const [resendingEmail, setResendingEmail] = useState<string | null>(null)
  const [localPendingInvites, setLocalPendingInvites] = useState<{ email: string; role: string }[]>([])
  const [saved, setSaved] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: org, isLoading } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => api.get<Team>(`/teams/${teamId}`).then((r) => r.data),
    enabled: !!teamId,
  })

  const updateModel = useMutation({
    mutationFn: (model: string) => api.patch(`/teams/${teamId}`, { default_ai_model: model }),
    onSuccess: (_, model) => {
      updateTeamModel(teamId!, model)
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      qc.invalidateQueries({ queryKey: ['teams'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const renameTeam = useMutation({
    mutationFn: (name: string) => api.patch(`/teams/${teamId}`, { name }),
    onSuccess: (_, name) => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      qc.invalidateQueries({ queryKey: ['teams'] })
      const { teams, activeTeam, setTeams, setActiveTeam } = useTeamStore.getState()
      const updated = teams.map((t) => t.id === teamId ? { ...t, name } : t)
      setTeams(updated)
      if (activeTeam && activeTeam.id === teamId) setActiveTeam({ ...activeTeam, name })
      setRenaming(false)
    },
  })

  const deleteTeam = useMutation({
    mutationFn: () => api.delete(`/teams/${teamId}`),
    onSuccess: () => {
      const { teams, activeTeam, setTeams, setActiveTeam } = useTeamStore.getState()
      const remaining = teams.filter((t) => t.id !== teamId)
      setTeams(remaining)
      if (activeTeam && activeTeam.id === teamId) setActiveTeam(remaining[0] ?? null)
      qc.invalidateQueries({ queryKey: ['teams'] })
      navigate('/')
    },
  })

  const invite = useMutation({
    mutationFn: () =>
      api.post(`/teams/${teamId}/invites`, {
        email: inviteEmail,
        role: inviteRole,
        invited_by_user_id: session!.user.id,
      }),
    onSuccess: (res) => {
      const sentEmail = inviteEmail.trim().toLowerCase()
      const sentRole = inviteRole
      setInviteEmail('')
      const payload = res?.data || {}
      if (payload.status === 'invite_queued') {
        setInviteMessage(`Invite saved — email couldn't be sent right now (rate limit). It will be sent later.`)
        setLocalPendingInvites((prev) => [...prev.filter((i) => i.email !== sentEmail), { email: sentEmail, role: sentRole }])
      } else if (payload.status === 'added_existing_user') {
        setInviteMessage(`${payload.email} is already registered and was added to the team.`)
      } else {
        const who = payload.invited_by_email ? ` by ${payload.invited_by_email}` : ''
        const orgName = payload.organization ? ` to ${payload.organization}` : ''
        setInviteMessage(`Invite sent${who}${orgName}.`)
        setLocalPendingInvites((prev) => [...prev.filter((i) => i.email !== sentEmail), { email: sentEmail, role: sentRole }])
      }
      qc.invalidateQueries({ queryKey: ['team', teamId] })
    },
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/teams/${teamId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  })

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  })

  const resendInvite = useMutation({
    mutationFn: ({ email, role }: { email: string; role: string }) =>
      api.post(`/teams/${teamId}/invites`, {
        email,
        role,
        invited_by_user_id: session!.user.id,
      }),
    onMutate: ({ email }) => setResendingEmail(email),
    onSettled: () => setResendingEmail(null),
    onSuccess: (_, { email }) => setInviteMessage(`Invite re-sent to ${email}.`),
  })

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => api.delete(`/teams/${teamId}/invites/${inviteId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  })

  const members = org?.members ?? []
  const memberSkillQueries = useQueries({
    queries: members.map((m) => ({
      queryKey: ['user-skills', m.user_id],
      queryFn: () => api.get<Skill[]>(`/skills/user/${m.user_id}`).then((r) => r.data),
      staleTime: 5 * 60 * 1000,
      enabled: !!org,
    })),
  })
  const skillsByUser = new Map<string, Skill[]>(
    members.map((m, i) => [m.user_id, memberSkillQueries[i]?.data ?? []])
  )

  if (isLoading || !org) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">Loading…</div>
  }

  const myRoleId = org.my_role_id ?? ''   // stable UUID for permission checks
  const canInvite = myRoleId === ROLE_IDS.owner || myRoleId === ROLE_IDS.admin
  const canDelete = myRoleId === ROLE_IDS.owner

  return (
    <div className="max-w-2xl mx-auto w-full px-6 py-10">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors">
        <ChevronLeft size={16} /> Back
      </button>

      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <Settings size={24} className="text-purple-400" />
          <div>
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newName.trim()) renameTeam.mutate(newName.trim())
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                  className="bg-gray-800 border border-purple-500 rounded px-2 py-1 text-white text-xl font-bold focus:outline-none w-52"
                />
                <button
                  onClick={() => newName.trim() && renameTeam.mutate(newName.trim())}
                  disabled={!newName.trim() || renameTeam.isPending}
                  className="text-xs px-2 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded"
                >
                  Save
                </button>
                <button onClick={() => setRenaming(false)} className="text-xs text-gray-400 hover:text-white">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-white">{org.name}</h1>
                <button
                  onClick={() => { setNewName(org.name); setRenaming(true) }}
                  className="text-gray-600 hover:text-gray-300 transition-colors"
                  title="Rename team"
                >
                  <Pencil size={14} />
                </button>
              </div>
            )}
            <p className="text-gray-500 text-sm">Team settings</p>
          </div>
        </div>
      </div>

      <div className="space-y-8">
        {/* Default AI model */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-1">Default AI Model</h2>
          <p className="text-gray-500 text-sm mb-4">
            All new projects in this team use this model unless overridden.
          </p>
          <div className="grid grid-cols-1 gap-2">
            {AI_MODELS.map((m) => (
              <button
                key={m.value}
                onClick={() => canInvite && updateModel.mutate(m.value)}
                disabled={!canInvite}
                className={`flex items-center justify-between px-4 py-3 rounded-lg border transition-all text-left ${
                  org.default_ai_model === m.value
                    ? 'border-purple-500 bg-purple-900/30 text-white'
                    : 'border-gray-700 text-gray-300 hover:border-gray-500 hover:bg-gray-800'
                } ${!canInvite ? 'opacity-60 cursor-not-allowed hover:border-gray-700 hover:bg-transparent' : ''}`}
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
            {(org.members ?? []).map((m) => {
              const memberSkills = skillsByUser.get(m.user_id) ?? []
              return (
                <div key={m.user_id} className="flex items-start justify-between px-3 py-2.5 bg-gray-800 rounded-lg gap-3">
                  <div className="flex-1 min-w-0">
                    {m.full_name && <p className="text-sm text-white">{m.full_name}</p>}
                    {m.email && <p className={`text-sm ${m.full_name ? 'text-gray-400' : 'text-white'}`}>{m.email}</p>}
                    {!m.email && !m.full_name && <p className="text-sm text-gray-500 italic">Unknown user</p>}
                    {myRoleId === ROLE_IDS.owner && m.user_id !== session?.user.id && m.role_id !== ROLE_IDS.owner ? (
                      <select
                        value={m.role}
                        onChange={(e) => changeRole.mutate({ userId: m.user_id, role: e.target.value })}
                        className="mt-0.5 bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-gray-300 capitalize focus:outline-none focus:ring-1 focus:ring-purple-500"
                      >
                        <option value="admin">admin</option>
                        <option value="member">member</option>
                      </select>
                    ) : (
                      <p className="text-xs text-gray-500 capitalize">{m.role}</p>
                    )}
                    {memberSkills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {memberSkills.map((s) => (
                          <span
                            key={s.id}
                            className="text-[11px] px-2 py-0.5 rounded-full bg-purple-900/40 text-purple-300 border border-purple-700/40"
                          >
                            {s.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {canInvite && m.user_id !== session?.user.id && (
                    <button
                      onClick={() => removeMember.mutate(m.user_id)}
                      className="text-gray-600 hover:text-red-400 transition-colors mt-0.5 shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {(() => {
            const serverEmails = new Set((org.pending_invites ?? []).map((i) => i.email))
            const merged = [
              ...(org.pending_invites ?? []),
              ...localPendingInvites
                .filter((i) => !serverEmails.has(i.email))
                .map((i) => ({ id: i.email, email: i.email, role: i.role as TeamPendingInvite['role'], invited_by_email: undefined, invited_at: '', status: 'pending' as const })),
            ]
            if (merged.length === 0) return null
            return (
              <div className="mb-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Pending invites</p>
                <div className="space-y-2">
                  {merged.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between px-3 py-2 bg-gray-800/60 rounded-lg">
                      <div>
                        <p className="text-sm text-white">{inv.email}</p>
                        <p className="text-xs text-gray-500">
                          {inv.role}{inv.invited_by_email ? ` • invited by ${inv.invited_by_email}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => resendInvite.mutate({ email: inv.email, role: inv.role })}
                          disabled={resendingEmail === inv.email}
                          title="Resend invite email"
                          className="text-gray-500 hover:text-yellow-300 transition-colors disabled:opacity-40"
                        >
                          <RotateCcw size={13} className={resendingEmail === inv.email ? 'animate-spin' : ''} />
                        </button>
                        <span className="text-[11px] px-2 py-1 rounded bg-yellow-900/40 text-yellow-300 border border-yellow-700/40">
                          invite sent
                        </span>
                        {canInvite && inv.id !== inv.email && (
                          <button
                            onClick={() => revokeInvite.mutate(inv.id)}
                            disabled={revokeInvite.isPending}
                            title="Revoke invite"
                            className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Invite by email — admins and owners only */}
          {canInvite && (
          <div className="border-t border-gray-800 pt-4">
            <p className="text-sm text-gray-400 mb-2">Invite member by email</p>
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm focus:outline-none"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={() => invite.mutate()}
                disabled={!inviteEmail.trim() || invite.isPending || !session?.user.id}
                className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                <UserPlus size={14} />
                Invite
              </button>
            </div>
            {inviteMessage && <p className="text-xs text-green-400 mt-2">{inviteMessage}</p>}
          </div>
          )}
        </section>

        {/* Danger zone — owners only */}
        {canDelete && (
        <section className="bg-gray-900 border border-red-900/50 rounded-xl p-5">
          <h2 className="font-semibold text-red-400 mb-1">Danger zone</h2>
          <p className="text-gray-500 text-sm mb-4">Permanently delete this team and all its projects. This cannot be undone.</p>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 border border-red-800 rounded-lg hover:bg-red-900/30 transition-colors"
            >
              <Trash2 size={14} />
              Delete team
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <p className="text-sm text-red-300">Delete <span className="font-bold">{org.name}</span>?</p>
              <button
                onClick={() => deleteTeam.mutate()}
                disabled={deleteTeam.isPending}
                className="px-3 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {deleteTeam.isPending ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
            </div>
          )}
        </section>
        )}
      </div>
    </div>
  )
}
