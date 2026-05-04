import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Bot, Plus, Pencil, Check, X, LinkIcon, ExternalLink, Container, KeyRound } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useCompanyStore } from '../store/companyStore'
import api from '../lib/api'
import toast from 'react-hot-toast'
import type { CompanyAgent } from '../types'
import { ExtraEnvEditor } from '../components/ExtraEnvEditor'
import { envPairsToObj, envObjToPairs } from '../lib/envUtils'
import type { EnvPair } from '../lib/envUtils'

type AgentType = 'webhook' | 'builtin'

export default function AgentsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { session } = useAuthStore()
  const { company } = useCompanyStore()

  const userId = session?.user?.id ?? ''
  const isOwner = !!company && company.owner_id === userId

  // ── Add agent form state ───────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false)
  const [addType, setAddType] = useState<AgentType>('webhook')
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState('')
  const [addWebhook, setAddWebhook] = useState('')
  const [addDockerImage, setAddDockerImage] = useState('')
  const [addApiKey, setAddApiKey] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addEnvPairs, setAddEnvPairs] = useState<EnvPair[]>([])

  // ── Edit agent state ───────────────────────────────────────────────────────
  const [editId, setEditId] = useState<string | null>(null)
  const [editType, setEditType] = useState<AgentType>('webhook')
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('')
  const [editWebhook, setEditWebhook] = useState('')
  const [editDockerImage, setEditDockerImage] = useState('')
  const [editApiKey, setEditApiKey] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editEnvPairs, setEditEnvPairs] = useState<EnvPair[]>([])

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['company-agents', company?.id],
    queryFn: () =>
      api
        .get<CompanyAgent[]>(`/companies/${company!.id}/agents`, { params: { user_id: userId } })
        .then((r) => r.data),
    enabled: !!company?.id && !!userId,
  })

  const addAgent = useMutation({
    mutationFn: () =>
      api.post(
        `/companies/${company!.id}/agents`,
        {
          name: addName.trim(),
          role: addRole.trim() || undefined,
          agent_type: addType,
          webhook_url: addType === 'webhook' ? addWebhook.trim() || undefined : undefined,
          docker_image: addType === 'builtin' ? addDockerImage.trim() || undefined : undefined,
          agent_api_key: addApiKey.trim() || undefined,
          extra_env: envPairsToObj(addEnvPairs),
          description: addDesc.trim() || undefined,
        },
        { params: { user_id: userId } }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-agents', company?.id] })
      setShowAdd(false)
      setAddName(''); setAddRole(''); setAddWebhook(''); setAddDockerImage('')
      setAddApiKey(''); setAddDesc(''); setAddEnvPairs([])
      toast.success('Agent registered')
    },
    onError: () => toast.error('Failed to add agent'),
  })

  const updateAgent = useMutation({
    mutationFn: () => {
      const update: Record<string, unknown> = {}
      if (editName.trim()) update.name = editName.trim()
      if (editRole.trim()) update.role = editRole.trim()
      update.agent_type = editType
      if (editType === 'webhook' && editWebhook.trim()) update.webhook_url = editWebhook.trim()
      if (editType === 'builtin' && editDockerImage.trim()) update.docker_image = editDockerImage.trim()
      if (editApiKey.trim() && editApiKey !== '***') update.agent_api_key = editApiKey.trim()
      if (editDesc.trim()) update.description = editDesc.trim()
      // Only send extra_env when every pair has been explicitly (re-)entered.
      // If any isMasked pairs remain the server would replace the whole column with
      // only the visible keys, silently dropping the still-masked secrets.
      const hasMaskedEnv = editEnvPairs.some((p) => p.isMasked)
      if (!hasMaskedEnv) {
        const env = envPairsToObj(editEnvPairs)
        if (env !== undefined) update.extra_env = env
      }
      return api.patch(`/companies/${company!.id}/agents/${editId}`, update, {
        params: { user_id: userId },
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-agents', company?.id] })
      setEditId(null)
      toast.success('Agent updated')
    },
    onError: () => toast.error('Failed to update agent'),
  })

  const deleteAgent = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/companies/${company!.id}/agents/${id}`, { params: { user_id: userId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-agents', company?.id] })
      toast.success('Agent removed')
    },
    onError: () => toast.error('Failed to remove agent'),
  })

  function startEdit(a: CompanyAgent) {
    setEditId(a.id)
    setEditType(a.agent_type ?? 'webhook')
    setEditName(a.name)
    setEditRole(a.role ?? '')
    setEditWebhook(a.webhook_url ?? '')
    setEditDockerImage(a.docker_image ?? '')
    setEditApiKey(a.agent_api_key ?? '')
    setEditDesc(a.description ?? '')
    setEditEnvPairs(envObjToPairs(a.extra_env))
  }

  if (!company) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">No company found.</div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-10">
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
      >
        <ChevronLeft size={16} /> Back
      </button>

      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <Bot size={24} className="text-purple-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Agents</h1>
            <p className="text-gray-500 text-sm">{company.name} — reusable webhook & builtin agents</p>
          </div>
        </div>
        {isOwner && (
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm rounded-lg transition-colors"
          >
            <Plus size={14} /> Register agent
          </button>
        )}
      </div>

      {/* Add form */}
      {showAdd && (
        <section className="bg-gray-900 border border-purple-700/50 rounded-xl p-5 mb-6 space-y-3">
          <h2 className="text-sm font-semibold text-white">New agent</h2>

          {/* Type toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAddType('webhook')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${addType === 'webhook' ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              <LinkIcon size={12} /> Webhook
            </button>
            <button
              type="button"
              onClick={() => setAddType('builtin')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${addType === 'builtin' ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              <Container size={12} /> Builtin Docker
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Name *</label>
              <input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Design Agent"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Role</label>
              <input
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                placeholder="UI/UX Designer"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>

          {addType === 'webhook' ? (
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Webhook URL *</label>
              <input
                value={addWebhook}
                onChange={(e) => setAddWebhook(e.target.value)}
                placeholder="https://your-agent.example.com/run"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Docker image *</label>
              <input
                value={addDockerImage}
                onChange={(e) => setAddDockerImage(e.target.value)}
                placeholder="ownflow-figma-agent:latest"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs text-gray-400">API key <span className="text-gray-600">(X-Api-Key header for webhooks)</span></label>
            <input
              value={addApiKey}
              onChange={(e) => setAddApiKey(e.target.value)}
              type="password"
              placeholder="Optional secret"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
          <ExtraEnvEditor pairs={addEnvPairs} onChange={setAddEnvPairs} />
          <div className="space-y-1">
            <label className="text-xs text-gray-400">Description</label>
            <input
              value={addDesc}
              onChange={(e) => setAddDesc(e.target.value)}
              placeholder="What this agent specialises in"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => addAgent.mutate()}
              disabled={addAgent.isPending || !addName.trim() || (addType === 'webhook' ? !addWebhook.trim() : !addDockerImage.trim())}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
            >
              <Check size={13} /> {addAgent.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {/* Agent list */}
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : agents.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Bot size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No agents registered yet.</p>
          {isOwner && (
            <p className="text-xs mt-1">
              Click <span className="text-purple-400">Register agent</span> to add one.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((a) =>
            editId === a.id ? (
              <section key={a.id} className="bg-gray-900 border border-purple-700/50 rounded-xl p-5 space-y-3">
                {/* Type toggle */}
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditType('webhook')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${editType === 'webhook' ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    <LinkIcon size={12} /> Webhook
                  </button>
                  <button type="button" onClick={() => setEditType('builtin')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${editType === 'builtin' ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    <Container size={12} /> Builtin Docker
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Name</label>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Role</label>
                    <input value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                </div>
                {editType === 'webhook' ? (
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Webhook URL</label>
                    <input value={editWebhook} onChange={(e) => setEditWebhook(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Docker image</label>
                    <input value={editDockerImage} onChange={(e) => setEditDockerImage(e.target.value)} placeholder="ownflow-figma-agent:latest" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">API key (leave blank to keep existing)</label>
                  <input value={editApiKey} onChange={(e) => setEditApiKey(e.target.value)} type="password" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500" />
                </div>
                <ExtraEnvEditor pairs={editEnvPairs} onChange={setEditEnvPairs} />
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Description</label>
                  <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => updateAgent.mutate()} disabled={updateAgent.isPending} className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg">
                    <Check size={13} /> {updateAgent.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditId(null)} className="px-4 py-2 text-gray-400 hover:text-white text-sm">
                    Cancel
                  </button>
                </div>
              </section>
            ) : (
              <div
                key={a.id}
                className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-start gap-4"
              >
                <div className="mt-0.5 p-2 bg-gray-800 rounded-lg shrink-0">
                  <Bot size={18} className="text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white">{a.name}</span>
                    {a.role && (
                      <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
                        {a.role}
                      </span>
                    )}
                    {/* Agent type badge */}
                    {a.agent_type === 'builtin' ? (
                      <span className="flex items-center gap-1 text-xs text-purple-300 bg-purple-900/30 px-2 py-0.5 rounded-full">
                        <Container size={10} /> Builtin
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-green-400 bg-green-900/20 px-2 py-0.5 rounded-full">
                        <LinkIcon size={10} /> Webhook
                      </span>
                    )}
                    {a.agent_api_key && (
                      <span className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-900/20 px-2 py-0.5 rounded-full">
                        <KeyRound size={10} /> API key set
                      </span>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-gray-400 text-sm mt-1">{a.description}</p>
                  )}
                  {/* Dispatch target */}
                  {a.agent_type === 'webhook' && a.webhook_url && (
                    <div className="flex items-center gap-1.5 mt-2">
                      <LinkIcon size={11} className="text-gray-500 shrink-0" />
                      <span className="text-xs text-gray-500 font-mono truncate">{a.webhook_url}</span>
                      {/^https?:\/\//.test(a.webhook_url) && (
                        <a href={a.webhook_url} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-gray-400 shrink-0">
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  )}
                  {a.agent_type === 'builtin' && a.docker_image && (
                    <div className="flex items-center gap-1.5 mt-2">
                      <Container size={11} className="text-gray-500 shrink-0" />
                      <span className="text-xs text-gray-500 font-mono truncate">{a.docker_image}</span>
                    </div>
                  )}
                  {/* Extra env keys preview */}
                  {a.extra_env && Object.keys(a.extra_env).length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      <KeyRound size={10} className="text-gray-600" />
                      {Object.keys(a.extra_env).map((k) => (
                        <span key={k} className="text-xs text-gray-600 font-mono bg-gray-800 px-1.5 py-0.5 rounded">{k}</span>
                      ))}
                    </div>
                  )}
                </div>
                {isOwner && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(a)}
                      className="p-1.5 text-gray-500 hover:text-white rounded transition-colors"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => deleteAgent.mutate(a.id)}
                      disabled={deleteAgent.isPending}
                      className="p-1.5 text-gray-500 hover:text-red-400 rounded transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}

      <div className="mt-8 p-4 bg-gray-900 border border-gray-800 rounded-xl">
        <p className="text-xs text-gray-500 leading-relaxed">
          Registered agents are available across all projects in <span className="text-gray-300">{company.name}</span>.
          When adding an actor to a project, paste the agent's webhook URL to route tasks to it automatically.
          See <span className="text-purple-400">docs/agent-flow.md</span> for the full dispatch protocol.
        </p>
      </div>
    </div>
  )
}
