import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import api from '../lib/api'
import { useProjectStore } from '../store/projectStore'
import { useRealtimeProject } from '../hooks/useRealtimeProject'
import type { Project } from '../types'
import TaskCard from '../components/TaskCard'
import TaskDrawer from '../components/TaskDrawer'
import { ChevronLeft, ChevronDown, Loader2, AlertCircle, Bot, User, Sparkles, Settings2, X, Plus, Trash2, Send, CheckCircle, Activity, GitBranch, LinkIcon, Unlink } from 'lucide-react'
import { format } from 'date-fns'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'o3-mini', label: 'o3-mini' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
]

const COLUMNS = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  { id: 'rework', label: 'Rework' },
] as const

export default function ProjectBoardPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { currentProject, setCurrentProject } = useProjectStore()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeSprint, setActiveSprint] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  // Board-level prompt
  const [boardPrompt, setBoardPrompt] = useState('')
  const [boardPromptStreaming, setBoardPromptStreaming] = useState(false)
  const [boardChatHistory, setBoardChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [showBoardChat, setShowBoardChat] = useState(false)
  const boardChatBottomRef = useRef<HTMLDivElement | null>(null)
  const boardPromptAbortRef = useRef<AbortController | null>(null)
  const [createdMsgIndices, setCreatedMsgIndices] = useState<Set<number>>(new Set())
  const [boardMinimized, setBoardMinimized] = useState(false)
  const [settingsName, setSettingsName] = useState('')
  const [settingsPrompt, setSettingsPrompt] = useState('')
  const [settingsSprintDays, setSettingsSprintDays] = useState<number>(3)
  // New actor form state
  const [newActorName, setNewActorName] = useState('')
  const [newActorRole, setNewActorRole] = useState('')
  const [newActorType, setNewActorType] = useState<'ai' | 'human'>('ai')
  const [newActorModel, setNewActorModel] = useState('gpt-4o')
  const [repoInput, setRepoInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [githubError, setGithubError] = useState('')

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () =>
      api.get<Project>(`/projects/${projectId}`).then((r) => {
        const d = r.data
        // Supabase returns assignments as a single object {} when the table has a
        // unique constraint on task_id — normalize to array [] for the frontend.
        if (d.tasks) {
          d.tasks = d.tasks.map((t) => ({
            ...t,
            assignments: Array.isArray(t.assignments)
              ? t.assignments
              : t.assignments
              ? [t.assignments as any]
              : [],
          }))
        }
        return d
      }),
    enabled: !!projectId,
    refetchInterval: (query) => (query.state.data?.status === 'planning' ? 3000 : false),
  })

  const qc = useQueryClient()
  const saveSettings = useMutation({
    mutationFn: () =>
      api.patch(`/projects/${projectId}/settings`, {
        name: settingsName,
        prompt: settingsPrompt,
        sprint_days: settingsSprintDays,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      setShowSettings(false)
    },
  })

  const addActor = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/actors`, {
        project_id: projectId,
        name: newActorName,
        role: newActorRole || undefined,
        type: newActorType,
        model: newActorType === 'ai' ? newActorModel : undefined,
        capabilities: [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      setNewActorName('')
      setNewActorRole('')
      setNewActorType('ai')
      setNewActorModel('gpt-4o')
    },
  })

  const removeActor = useMutation({
    mutationFn: (actorId: string) => api.delete(`/actors/${actorId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const planNextSprint = useMutation({
    mutationFn: (aiModel: string) =>
      api.post(`/projects/${projectId}/sprints/next`, { ai_model: aiModel }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const runReadyTasks = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/run-ready`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const { data: githubStatus, refetch: refetchGithub } = useQuery({
    queryKey: ['github-status', projectId],
    queryFn: () => api.get<{ connected: boolean; repo?: string }>(`/github/status?project_id=${projectId}`).then(r => r.data),
    enabled: !!projectId && showSettings,
  })

  const connectGithub = useMutation({
    mutationFn: ({ token, repo }: { token: string; repo: string }) =>
      api.post(`/github/connect?project_id=${projectId}`, { token, repo }),
    onSuccess: () => {
      refetchGithub()
      setTokenInput('')
      setRepoInput('')
      setGithubError('')
    },
    onError: (err: any) => {
      setGithubError(err?.response?.data?.detail ?? 'Connection failed')
    },
  })

  const setRepo = useMutation({
    mutationFn: (repo: string) => api.patch(`/github/repo?project_id=${projectId}`, { repo }),
    onSuccess: () => refetchGithub(),
  })

  const disconnectGithub = useMutation({
    mutationFn: () => api.delete(`/github/disconnect?project_id=${projectId}`),
    onSuccess: () => refetchGithub(),
  })

  type StructuredAction = {
    intent: 'create_tasks' | 'modify_tasks' | 'delete_tasks'
    tasks: { title: string; description?: string; type?: string; priority?: string; estimated_hours?: number; id?: string }[]
  }

  function parseStructuredAction(content: string): StructuredAction | null {
    const m = content.match(/```json\s*([\s\S]*?)```/)
    if (!m) return null
    try {
      const parsed = JSON.parse(m[1].trim())
      if (
        ['create_tasks', 'modify_tasks', 'delete_tasks'].includes(parsed.intent) &&
        Array.isArray(parsed.tasks)
      ) {
        return parsed as StructuredAction
      }
    } catch {}
    return null
  }

  const createTasksFromAI = useMutation({
    mutationFn: ({ tasks, sprintId }: { tasks: { title: string; estimated_hours?: number }[]; sprintId?: string }) =>
      api.post(`/projects/${projectId}/tasks`, { tasks, sprint_id: sprintId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const modifyTasksFromAI = useMutation({
    mutationFn: (tasks: StructuredAction['tasks']) =>
      api.patch(`/projects/${projectId}/tasks/batch`, { tasks }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const deleteTasksFromAI = useMutation({
    mutationFn: (tasks: StructuredAction['tasks']) =>
      api.delete(`/projects/${projectId}/tasks/batch`, { data: { tasks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  useRealtimeProject(projectId)

  useEffect(() => {
    if (data) {
      setCurrentProject(data)
      if (!activeSprint && data.sprints?.length) {
        setActiveSprint(data.sprints[0].id)
      }
      setSettingsName(data.name)
      setSettingsPrompt(data.prompt)
      setSettingsSprintDays(data.sprint_days ?? 3)
    }
  }, [data])

  const project = currentProject ?? data

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return
    const { draggableId, destination } = result
    const newStatus = destination.droppableId
    await api.patch(`/tasks/${draggableId}/status`, { status: newStatus })
    refetch()
  }

  const handleBoardPrompt = async () => {
    const msg = boardPrompt.trim()
    if (!msg || boardPromptStreaming) return
    setBoardPrompt('')
    setShowBoardChat(true)
    setBoardPromptStreaming(true)

    const userMsg: { role: 'user' | 'assistant'; content: string } = { role: 'user', content: msg }
    const newHistory = [...boardChatHistory, userMsg]
    // Start with empty content — we buffer silently and only show when done
    setBoardChatHistory([...newHistory, { role: 'assistant', content: '' }])

    const ctrl = new AbortController()
    boardPromptAbortRef.current = ctrl
    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetch(`${baseUrl}/projects/${projectId}/prompt/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg, history: boardChatHistory }),
        signal: ctrl.signal,
      })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') break
          try {
            const { content } = JSON.parse(payload)
            assistantContent += content
            // Don't update state mid-stream — reveal only when done
          } catch {}
        }
      }
      // Reveal final content all at once
      setBoardChatHistory([...newHistory, { role: 'assistant', content: assistantContent }])
    } catch {}

    setBoardPromptStreaming(false)
    setTimeout(() => boardChatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="text-purple-400 animate-spin" />
      </div>
    )
  }

  if (isError || !project) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-red-400">
        <AlertCircle size={20} /> Failed to load project
      </div>
    )
  }

  if (project.status === 'planning') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-400">
        <Loader2 size={40} className="text-purple-400 animate-spin" />
        <p className="text-lg font-medium text-white">AI is generating your plan…</p>
        <p className="text-sm">Breaking down tasks and creating sprints. This takes ~30 seconds.</p>
      </div>
    )
  }

  const sprints = project.sprints ?? []
  const actors = project.actors ?? []
  const sprintTasks = (project.tasks ?? []).filter((t) => t.sprint_id === activeSprint)

  // Show "Plan Next Sprint" when roadmap has more sprints than currently exist
  const roadmap = project.roadmap ?? []
  const maxRoadmapSprint = roadmap.length > 0 ? Math.max(...roadmap.map((r) => r.sprint_number)) : 0
  const currentSprintCount = sprints.length
  const canPlanNextSprint = project.status === 'active' && currentSprintCount < maxRoadmapSprint
  const nextSprintTheme = roadmap.find((r) => r.sprint_number === currentSprintCount + 1)



  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Top bar */}
      <div className="px-6 pt-5 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => navigate('/')}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <ChevronLeft size={18} />
          </button>
          <h1 className="text-white font-bold text-lg">{project.name}</h1>
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded capitalize">
            {project.status}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {(() => {
              const readyCount = (project.tasks ?? []).filter((t) => t.is_ready).length
              return readyCount > 0 ? (
                <button
                  onClick={() => runReadyTasks.mutate()}
                  disabled={runReadyTasks.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
                  title={`Run all ${readyCount} ready task${readyCount !== 1 ? 's' : ''}`}
                >
                  {runReadyTasks.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                  Run {readyCount} Ready
                </button>
              ) : null
            })()}
            {canPlanNextSprint && (
              <button
                onClick={() => planNextSprint.mutate(project.roadmap?.[0] ? 'gpt-4o' : 'gpt-4o')}
                disabled={planNextSprint.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {planNextSprint.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                Plan Sprint {currentSprintCount + 1}
                {nextSprintTheme && (
                  <span className="text-purple-200 text-xs">— {nextSprintTheme.theme}</span>
                )}
              </button>
            )}
            <button
              onClick={() => navigate(`/projects/${projectId}/activity`)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              title="Project activity"
            >
              <Activity size={16} />
            </button>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              title="Project settings"
            >
              <Settings2 size={16} />
            </button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="mb-3 p-4 bg-gray-900 border border-gray-700 rounded-xl space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">Project Settings</span>
              <button onClick={() => setShowSettings(false)} className="text-gray-500 hover:text-white">
                <X size={14} />
              </button>
            </div>

            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Project name</label>
              <input
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Project description / prompt</label>
              <textarea
                rows={4}
                value={settingsPrompt}
                onChange={(e) => setSettingsPrompt(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
            </div>

            {/* Sprint length */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">Sprint length (days) — applies to future sprints</label>
              <div className="flex items-center gap-2 flex-wrap">
                {[1, 2, 3, 5, 7, 10, 14].map((d) => (
                  <button
                    key={d}
                    onClick={() => setSettingsSprintDays(d)}
                    className={`w-9 h-8 rounded-lg text-sm font-medium transition-colors ${
                      settingsSprintDays === d
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }`}
                  >
                    {d}
                  </button>
                ))}
                <span className="text-xs text-gray-500 ml-1">{settingsSprintDays * 8}h capacity</span>
              </div>
            </div>

            <button
              onClick={() => saveSettings.mutate()}
              disabled={saveSettings.isPending}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
            >
              {saveSettings.isPending ? 'Saving…' : 'Save changes'}
            </button>

            {/* Divider */}
            <div className="border-t border-gray-700 pt-4">
              <label className="block text-xs font-medium text-gray-400 mb-3">Team actors</label>

              {/* Existing actors */}
              <div className="space-y-1.5 mb-3">
                {(project.actors ?? []).map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-sm">
                    {a.type === 'ai'
                      ? <Bot size={13} className="text-purple-400 shrink-0" />
                      : <User size={13} className="text-blue-400 shrink-0" />}
                    <span className="text-white flex-1">{a.name}</span>
                    {(a.role || a.model) && <span className="text-gray-500 text-xs">{a.role ?? a.model}</span>}
                    <button
                      onClick={() => removeActor.mutate(a.id)}
                      disabled={removeActor.isPending}
                      className="text-gray-600 hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add actor */}
              <div className="flex gap-2 items-end flex-wrap">
                <input
                  placeholder="Name"
                  value={newActorName}
                  onChange={(e) => setNewActorName(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 w-28"
                />
                <input
                  placeholder="Role (e.g. Lead QA)"
                  value={newActorRole}
                  onChange={(e) => setNewActorRole(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 w-36"
                />
                <select
                  value={newActorType}
                  onChange={(e) => setNewActorType(e.target.value as 'ai' | 'human')}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="ai">AI</option>
                  <option value="human">Human</option>
                </select>
                {newActorType === 'ai' && (
                  <select
                    value={newActorModel}
                    onChange={(e) => setNewActorModel(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    {AI_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => addActor.mutate()}
                  disabled={addActor.isPending || !newActorName.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>
            {/* GitHub integration */}
            <div className="border-t border-gray-700 pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <GitBranch size={13} className="text-gray-400" />
                <span className="text-xs font-medium text-gray-400">GitHub integration</span>
                {githubStatus?.connected && (
                  <span className="text-xs text-green-400 bg-green-900/30 border border-green-800/50 px-2 py-0.5 rounded-full">Connected</span>
                )}
              </div>
              {githubStatus?.connected ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-400">
                    Repo: <span className="text-white font-mono">{githubStatus.repo}</span>
                  </p>
                  <p className="text-xs text-gray-500">AI agents will open PRs to this repo when tasks are executed.</p>
                  <div className="flex gap-2 flex-wrap items-center">
                    <input
                      placeholder="owner/repo-name"
                      value={repoInput}
                      onChange={(e) => setRepoInput(e.target.value)}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 w-48 font-mono"
                    />
                    <button
                      onClick={() => { if (repoInput.trim()) setRepo.mutate(repoInput.trim()) }}
                      disabled={setRepo.isPending || !repoInput.trim()}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
                    >
                      <LinkIcon size={12} /> Change repo
                    </button>
                    <button
                      onClick={() => disconnectGithub.mutate()}
                      disabled={disconnectGithub.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 bg-red-900/40 border border-red-800/50 hover:bg-red-800/50 text-red-400 text-sm rounded-lg transition-colors"
                    >
                      <Unlink size={12} /> Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">Enter your GitHub credentials so AI agents can commit code and open pull requests.</p>
                  <div className="space-y-2">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">
                        Personal Access Token <span className="text-red-400">*</span>
                        <a href="https://github.com/settings/tokens/new?scopes=repo" target="_blank" rel="noopener noreferrer" className="ml-2 text-purple-400 hover:text-purple-300">(create token)</a>
                      </label>
                      <input
                        type="password"
                        placeholder="ghp_..."
                        value={tokenInput}
                        onChange={(e) => { setTokenInput(e.target.value); setGithubError('') }}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">
                        Repository <span className="text-red-400">*</span>
                      </label>
                      <input
                        placeholder="owner/repo-name"
                        value={repoInput}
                        onChange={(e) => { setRepoInput(e.target.value); setGithubError('') }}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    {githubError && (
                      <p className="text-xs text-red-400">{githubError}</p>
                    )}
                    <button
                      onClick={() => connectGithub.mutate({ token: tokenInput.trim(), repo: repoInput.trim() })}
                      disabled={connectGithub.isPending || !tokenInput.trim() || !repoInput.trim()}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
                    >
                      {connectGithub.isPending ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
                      Connect
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sprint tabs */}
        <div className="flex gap-1 overflow-x-auto">
          {sprints.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSprint(s.id)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activeSprint === s.id
                  ? 'bg-purple-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              Sprint {s.sprint_number}
              {s.start_date && (
                <span className="ml-1.5 text-xs opacity-70">
                  {format(new Date(s.start_date), 'MMM d')}–{format(new Date(s.end_date), 'd')}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Actors legend */}
      <div className="flex items-center gap-4 px-6 py-2 border-b border-gray-800/50 overflow-x-auto">
        {actors.map((a) => (
          <div key={a.id} className="flex items-center gap-1.5 text-xs text-gray-400 shrink-0">
            {a.type === 'ai' ? <Bot size={12} className="text-purple-400" /> : <User size={12} className="text-blue-400" />}
            <span>{a.name}</span>
            {a.model && <span className="text-gray-600">({a.model})</span>}
          </div>
        ))}
      </div>

      {/* Kanban board */}
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex-1 flex gap-4 overflow-x-auto px-6 py-4">
          {COLUMNS.map((col) => {
            const colTasks = sprintTasks.filter((t) => t.status === col.id)
            return (
              <div key={col.id} className="flex flex-col w-72 shrink-0">
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-sm font-medium text-gray-300">{col.label}</span>
                  <span className="text-xs text-gray-600 bg-gray-800 rounded-full w-5 h-5 flex items-center justify-center">
                    {colTasks.length}
                  </span>
                </div>
                <Droppable droppableId={col.id}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`flex-1 rounded-xl p-2 space-y-2 min-h-[200px] transition-colors ${
                        snapshot.isDraggingOver ? 'bg-gray-800/60' : 'bg-gray-900/30'
                      }`}
                    >
                      {colTasks.map((task, index) => (
                        <Draggable key={task.id} draggableId={task.id} index={index}>
                          {(prov) => (
                            <div
                              ref={prov.innerRef}
                              {...prov.draggableProps}
                              {...prov.dragHandleProps}
                            >
                              <TaskCard
                                task={task}
                                actors={actors}
                                onClick={() => setSelectedTaskId(task.id)}
                              />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            )
          })}
        </div>
      </DragDropContext>

      {/* Task Drawer */}
      {selectedTaskId && (() => {
        const liveTask = (project.tasks ?? []).find((t) => t.id === selectedTaskId)
        return liveTask ? (
          <TaskDrawer
            task={liveTask}
            actors={actors}
            onClose={() => setSelectedTaskId(null)}
          />
        ) : null
      })()}

      {/* Floating board prompt bar */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-40">
        <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 select-none">
            <Bot size={14} className="text-purple-400 shrink-0" />
            <span className="text-sm text-purple-400 font-medium">AI Assistant</span>
            {!boardMinimized && boardChatHistory.length > 0 && (
              <button
                onClick={() => { setBoardChatHistory([]); setShowBoardChat(false) }}
                className="text-gray-600 hover:text-gray-400 text-xs px-1"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setBoardMinimized((v) => !v)}
              className="ml-auto text-gray-500 hover:text-gray-300 transition-colors shrink-0"
              title={boardMinimized ? 'Expand Copilot' : 'Collapse Copilot'}
            >
              <ChevronDown size={15} className={`transition-transform ${boardMinimized ? '-rotate-90' : ''}`} />
            </button>
          </div>

          {!boardMinimized && showBoardChat && boardChatHistory.length > 0 && (
            <div className="border-b border-gray-800 p-3 max-h-64 overflow-y-auto space-y-2">
              {boardChatHistory.map((m, i) => {
                const isThinking = boardPromptStreaming && i === boardChatHistory.length - 1 && m.role === 'assistant'
                const action = m.role === 'assistant' && !isThinking && m.content ? parseStructuredAction(m.content) : null
                const alreadyConfirmed = createdMsgIndices.has(i)

                if (isThinking) {
                  return (
                    <div key={i} className="flex items-center gap-2 px-3 py-2 text-purple-400 text-sm">
                      <Loader2 size={14} className="animate-spin" />
                      <span className="opacity-70">Thinking…</span>
                    </div>
                  )
                }

                if (action) {
                  const isPending =
                    action.intent === 'create_tasks' ? createTasksFromAI.isPending
                    : action.intent === 'modify_tasks' ? modifyTasksFromAI.isPending
                    : deleteTasksFromAI.isPending

                  const intentLabel =
                    action.intent === 'create_tasks'
                      ? { label: `${action.tasks.length} task${action.tasks.length !== 1 ? 's' : ''} to create`, color: 'text-purple-400', confirmText: 'Add to board', confirmStyle: { background: 'rgba(168,85,247,0.2)', color: '#c084fc' } }
                      : action.intent === 'modify_tasks'
                        ? { label: `${action.tasks.length} task${action.tasks.length !== 1 ? 's' : ''} to update`, color: 'text-blue-400', confirmText: 'Apply changes', confirmStyle: { background: 'rgba(59,130,246,0.2)', color: '#93c5fd' } }
                        : { label: `${action.tasks.length} task${action.tasks.length !== 1 ? 's' : ''} to delete`, color: 'text-red-400', confirmText: 'Delete tasks', confirmStyle: { background: 'rgba(239,68,68,0.15)', color: '#f87171' } }

                  const handleConfirm = () => {
                    if (action.intent === 'create_tasks') {
                      createTasksFromAI.mutate(
                        { tasks: action.tasks, sprintId: activeSprint ?? undefined },
                        { onSuccess: () => setCreatedMsgIndices((prev) => new Set([...prev, i])) },
                      )
                    } else if (action.intent === 'modify_tasks') {
                      modifyTasksFromAI.mutate(action.tasks, {
                        onSuccess: () => setCreatedMsgIndices((prev) => new Set([...prev, i])),
                      })
                    } else {
                      deleteTasksFromAI.mutate(action.tasks, {
                        onSuccess: () => setCreatedMsgIndices((prev) => new Set([...prev, i])),
                      })
                    }
                  }

                  return (
                    <div key={i} className="bg-gray-950 border border-gray-700 rounded-xl p-3 space-y-2">
                      <p className={`text-xs font-semibold uppercase tracking-wide ${intentLabel.color}`}>
                        {intentLabel.label}
                      </p>
                      <div className="space-y-1.5">
                        {action.tasks.map((t, j) => (
                          <div key={j} className="flex items-start gap-2 bg-gray-900 rounded-lg px-3 py-2">
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm font-medium truncate ${action.intent === 'delete_tasks' ? 'text-gray-400 line-through' : 'text-white'}`}>
                                {t.title}
                              </p>
                              {t.description && <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{t.description}</p>}
                            </div>
                            <div className="flex gap-1.5 shrink-0 items-center">
                              {t.type && <span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{t.type}</span>}
                              {t.priority && (
                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                  t.priority === 'high'
                                    ? 'bg-red-900/50 text-red-400'
                                    : t.priority === 'medium'
                                      ? 'bg-yellow-900/50 text-yellow-400'
                                      : 'bg-gray-800 text-gray-400'
                                }`}>
                                  {t.priority}
                                </span>
                              )}
                              {t.estimated_hours != null && <span className="text-xs text-gray-500">{t.estimated_hours}h</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-end pt-1">
                        <button
                          onClick={handleConfirm}
                          disabled={alreadyConfirmed || isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                          style={alreadyConfirmed
                            ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' }
                            : intentLabel.confirmStyle}
                        >
                          {alreadyConfirmed
                            ? <><CheckCircle size={12} /> Done</>
                            : isPending
                              ? <><Loader2 size={12} className="animate-spin" /> Working…</>
                              : <><Plus size={12} /> {intentLabel.confirmText}</>}
                        </button>
                      </div>
                    </div>
                  )
                }

                return (
                  <div key={i} className={`text-sm rounded-lg px-3 py-2 whitespace-pre-wrap ${m.role === 'user' ? 'bg-gray-800 text-gray-200 text-right' : 'bg-gray-950 text-gray-300'}`}>
                    {m.content}
                  </div>
                )
              })}
              <div ref={boardChatBottomRef} />
            </div>
          )}

          {!boardMinimized ? (
            <div className="flex gap-2 items-center px-3 py-2">
              <input
                type="text"
                value={boardPrompt}
                onChange={(e) => setBoardPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleBoardPrompt() }}
                placeholder={`Ask AI about ${project.name}…`}
                className="flex-1 bg-transparent text-white text-sm focus:outline-none placeholder-gray-600"
              />
              <button
                onClick={handleBoardPrompt}
                disabled={!boardPrompt.trim() || boardPromptStreaming}
                className="p-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                {boardPromptStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </div>
          ) : (
            <div className="px-3 py-2 text-sm text-gray-600 select-none">AI assistant</div>
          )}
        </div>
      </div>
    </div>
  )
}
