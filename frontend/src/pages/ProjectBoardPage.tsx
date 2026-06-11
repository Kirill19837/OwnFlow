import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'
import { useCompanyStore } from '../store/companyStore'
import { useProjectStore } from '../store/projectStore'
import { useRealtimeProject } from '../hooks/useRealtimeProject'
import type { Project, Assignment, TeamMember, Skill, CompanyAgent } from '../types'
import { ExtraEnvEditor } from '../components/ExtraEnvEditor'
import { envObjToPairs } from '../lib/envUtils'
import type { EnvPair } from '../lib/envUtils'
import { useAiLimitStore } from '../store/aiLimitStore'

// Mirrors backend ROLE_IMAGE_MAP in actor_executor.py
const ROLE_IMAGE_MAP: Record<string, string> = {
  'default': 'ownflow-agent:latest',
  'ui/ux designer': 'ownflow-figma-agent:latest',
  'business analyst': 'ownflow-docs-agent:latest',
}

function resolveActorImage(actor: { webhook_url?: string; docker_image?: string | null; role?: string }): string | null {
  if (actor.webhook_url) return null  // webhook — no Docker image
  if (actor.docker_image) return actor.docker_image
  const role = (actor.role || '').trim().toLowerCase()
  return ROLE_IMAGE_MAP[role] ?? ROLE_IMAGE_MAP['default']
}

/** Returns how the image was resolved: 'explicit' | 'role' | 'default' */
function resolveActorImageSource(actor: { webhook_url?: string; docker_image?: string | null; role?: string }): 'webhook' | 'explicit' | 'role' | 'default' {
  if (actor.webhook_url) return 'webhook'
  if (actor.docker_image) return 'explicit'
  const role = (actor.role || '').trim().toLowerCase()
  if (role && ROLE_IMAGE_MAP[role]) return 'role'
  return 'default'
}
import TaskCard from '../components/TaskCard'
import TaskDrawer from '../components/TaskDrawer'
import RepoGateModal from '../components/RepoGateModal'
import { AiCommandsModal } from '../components/AiCommandsModal'
import { ChevronLeft, ChevronDown, Loader2, AlertCircle, Bot, User, Sparkles, Settings2, X, Plus, Trash2, Send, CheckCircle, Activity, GitBranch, LinkIcon, Unlink, Zap, HelpCircle, Brain } from 'lucide-react'
import { format } from 'date-fns'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'o3-mini', label: 'o3-mini' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

const COLUMNS = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  { id: 'rework', label: 'Rework' },
] as const

async function fetchWithLimitCheck(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 402) {
    try {
      const body = await res.clone().json()
      const detail: string = body?.detail ?? ''
      const match = detail.match(/(\d+)\/(\d+)/)
      useAiLimitStore.getState().open(
          match ? { used: Number(match[1]), limit: Number(match[2]) } : {}
      )
    } catch {
      useAiLimitStore.getState().open()
    }
    throw new Error('AI prompt limit reached')
  }
  return res
}

export default function ProjectBoardPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { session } = useAuthStore()
  const { company } = useCompanyStore()
  const { currentProject, setCurrentProject } = useProjectStore()
  const userId = session?.user?.id ?? ''
  const selectedTaskId = searchParams.get('task')
  const setSelectedTaskId = (id: string | null) =>
    setSearchParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set('task', id); else next.delete('task'); return next }, { replace: true })
  const [activeSprint, setActiveSprint] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(
    () => searchParams.get('github_connected') === '1'
  )

  // Board-level prompt
  const [boardPrompt, setBoardPrompt] = useState('')
  const [boardPromptStreaming, setBoardPromptStreaming] = useState(false)
  type BoardChatMsg =
    | { role: 'user' | 'assistant'; content: string }
    | { role: 'memory'; titles: string[]; decisions: string[] }
  const [boardChatHistory, setBoardChatHistory] = useState<BoardChatMsg[]>([])
  const [showBoardChat, setShowBoardChat] = useState(false)
  const boardChatBottomRef = useRef<HTMLDivElement | null>(null)
  const boardPromptAbortRef = useRef<AbortController | null>(null)
  const [createdMsgIndices, setCreatedMsgIndices] = useState<Set<number>>(new Set())
  const [boardMinimized, setBoardMinimized] = useState(false)
  const [showBoardCommands, setShowBoardCommands] = useState(false)
  const [settingsName, setSettingsName] = useState('')
  const [settingsPrompt, setSettingsPrompt] = useState('')
  const [settingsSprintDays, setSettingsSprintDays] = useState<number>(3)
  // Per-actor extra_env edit state: actorId → EnvPair[]
  const [actorEnvEdits, setActorEnvEdits] = useState<Record<string, EnvPair[]>>({})
  const [actorEnvOpen, setActorEnvOpen] = useState<Record<string, boolean>>({})
  const [repoInput, setRepoInput] = useState('')
  const [showRunReadyRepoGate, setShowRunReadyRepoGate] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'general' | 'agents' | 'team-actors' | 'github'>('general')
  const [showRolePicker, setShowRolePicker] = useState(false)

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
              ? [t.assignments as Assignment]
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
    mutationFn: (payload: {
      name: string
      role?: string
      type: 'ai' | 'human'
      model?: string
      user_id?: string | null
      webhook_url?: string
      docker_image?: string
      company_agent_id?: string
      extra_env?: Record<string, string>
    }) =>
      api.post(`/projects/${projectId}/actors`, {
        project_id: projectId,
        ...payload,
        capabilities: [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const removeActor = useMutation({
    mutationFn: (actorId: string) => api.delete(`/actors/${actorId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const updateActor = useMutation({
    mutationFn: ({ actorId, patch }: { actorId: string; patch: Record<string, unknown> }) =>
      api.patch(`/actors/${actorId}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const autoFillActors = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/actors/auto-fill`, {
        ai_model: 'gpt-4o',
      }),
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
    queryFn: () => api.get<{ connected: boolean; has_token?: boolean; repo?: string; github_user?: string }>(`/github/status?project_id=${projectId}`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: githubTeamStatus } = useQuery({
    queryKey: ['github-team-status', data?.team_id],
    queryFn: () => api.get<{ connected: boolean; github_user?: string }>(`/github/team-status?team_id=${data?.team_id}`).then(r => r.data),
    enabled: !!data?.team_id,
  })

  // Team is connected if either the project has its own connection or the team has one
  const teamGithubConnected = !!githubTeamStatus?.connected
  const githubTokenAvailable = !!githubStatus?.has_token || teamGithubConnected
  const githubFullyConnected = !!githubStatus?.connected || teamGithubConnected
  // Repo is actually selected for this project (required for PRs)
  const githubRepoConnected = !!githubStatus?.connected && !!githubStatus?.repo

  const { data: githubRepos } = useQuery({
    queryKey: ['github-repos', projectId, data?.team_id],
    queryFn: () => {
      const param = data?.team_id ? `team_id=${data.team_id}` : `project_id=${projectId}`
      return api.get<{ repos: { full_name: string; private: boolean }[] }>(`/github/repos?${param}`).then(r => r.data.repos)
    },
    enabled: !!projectId && githubTokenAvailable,
  })

  const { data: companyAgents = [] } = useQuery<CompanyAgent[]>({
    queryKey: ['company-agents', company?.id],
    queryFn: () =>
      api
        .get<CompanyAgent[]>(`/companies/${company!.id}/agents`, { params: { user_id: userId } })
        .then((r) => r.data),
    enabled: !!company?.id && !!userId && showSettings && settingsTab === 'team-actors',
    staleTime: 5 * 60 * 1000,
  })

  const { data: teamData, isLoading: teamMembersLoading } = useQuery({
    queryKey: ['team', data?.team_id],
    queryFn: () => api.get<{ members?: TeamMember[] }>(`/teams/${data!.team_id}`).then((r) => r.data),
    enabled: !!data?.team_id && showSettings && settingsTab === 'team-actors',
  })
  const teamMembers: TeamMember[] = useMemo(() => teamData?.members ?? [], [teamData?.members])

  const { data: skills = [] } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: () => api.get<Skill[]>('/skills').then((r) => r.data),
    enabled: showSettings && settingsTab === 'team-actors',
    staleTime: 5 * 60 * 1000,
  })
  const roleCategories = useMemo(() => [...new Set(skills.map((s) => s.category))], [skills])

  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:8000'
  void apiBase // reserved for future use

  // Auto-open settings when GitHub redirects back with ?github_connected=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('github_connected') === '1') {
      refetchGithub()
      // Clean the URL
      const clean = window.location.pathname
      window.history.replaceState({}, '', clean)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setRepo = useMutation({
    mutationFn: (repo: string) => api.patch(`/github/repo?project_id=${projectId}`, { repo }),
    onSuccess: () => refetchGithub(),
  })

  const disconnectGithub = useMutation({
    mutationFn: () => api.delete(`/github/disconnect?project_id=${projectId}`),
    onSuccess: () => refetchGithub(),
  })

  type StructuredAction =
    | { intent: 'create_tasks'; tasks: { title: string; description?: string; type?: string; priority?: string; estimated_hours?: number; id?: string; actor_id?: string }[] }
    | { intent: 'modify_tasks'; tasks: { title: string; description?: string; type?: string; priority?: string; estimated_hours?: number; id?: string }[] }
    | { intent: 'delete_tasks'; tasks: { title: string; description?: string; type?: string; priority?: string; estimated_hours?: number; id?: string }[] }
    | { intent: 'assign_actor'; task_id: string; actor_id: string; actor_name: string }

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
      if (parsed.intent === 'assign_actor' && parsed.task_id && parsed.actor_id) {
        return parsed as StructuredAction
      }
    } catch { /* invalid JSON — not a structured action */ }
    return null
  }

  const createTasksFromAI = useMutation({
    mutationFn: ({ tasks, sprintId }: { tasks: { title: string; estimated_hours?: number }[]; sprintId?: string }) =>
      api.post(`/projects/${projectId}/tasks`, { tasks, sprint_id: sprintId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const modifyTasksFromAI = useMutation({
    mutationFn: (tasks: { id?: string; title?: string; description?: string; type?: string; priority?: string; estimated_hours?: number }[]) =>
      api.patch(`/projects/${projectId}/tasks/batch`, { tasks }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const deleteTasksFromAI = useMutation({
    mutationFn: (tasks: { id?: string }[]) =>
      api.delete(`/projects/${projectId}/tasks/batch`, { data: { tasks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const assignFromBoard = useMutation({
    mutationFn: ({ taskId, actorId }: { taskId: string; actorId: string }) =>
      api.patch(`/tasks/${taskId}/assign`, { actor_id: actorId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  useRealtimeProject(projectId)

  /* eslint-disable react-hooks/set-state-in-effect */
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
  }, [data, activeSprint, setCurrentProject])
  /* eslint-enable react-hooks/set-state-in-effect */

  const project = currentProject ?? data

  const addFromTemplate = (skill: Skill, typeOverride?: 'human' | 'ai') => {
    const type = typeOverride ?? (skill.actor_type === 'both' ? 'ai' : skill.actor_type as 'human' | 'ai')
    addActor.mutate({
      name: type === 'ai' ? skill.name : 'Unassigned teammate',
      role: skill.name,
      type,
      model: type === 'ai' ? 'gpt-4o' : undefined,
    })
  }

  const addHumanTeammate = () => {
    const used = new Set((project?.actors ?? []).map((a) => a.user_id).filter(Boolean))
    const candidate = teamMembers.find((m) => !used.has(m.user_id))
    addActor.mutate({
      name: candidate?.full_name || candidate?.email || 'Unassigned teammate',
      role: 'Contributor',
      type: 'human',
      user_id: candidate?.user_id ?? null,
    })
  }

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
    const newHistory: BoardChatMsg[] = [...boardChatHistory, userMsg]
    // Start with empty content — we buffer silently and only show when done
    setBoardChatHistory([...newHistory, { role: 'assistant', content: '' }])

    const ctrl = new AbortController()
    boardPromptAbortRef.current = ctrl
    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetchWithLimitCheck(`${baseUrl}/projects/${projectId}/prompt/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: msg,
          history: boardChatHistory.filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role === 'user' || m.role === 'assistant'),
          actors: (project?.actors ?? []).map((a) => ({
            id: a.id, name: a.name, role: a.role, type: a.type, model: a.model,
          })),
        }),
        signal: ctrl.signal,
      })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''
      let memoryEvent: { titles: string[]; decisions: string[] } | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') break
          try {
            const obj = JSON.parse(payload)
            if (obj.type === 'memory_event') {
              memoryEvent = { titles: obj.titles || [], decisions: obj.decisions || [] }
              // Reveal memory card immediately while assistant is still streaming
              setBoardChatHistory([
                ...newHistory,
                { role: 'memory', titles: memoryEvent.titles, decisions: memoryEvent.decisions },
                { role: 'assistant', content: '' },
              ])
              continue
            }
            if (typeof obj.content === 'string') {
              assistantContent += obj.content
              // Don't update state mid-stream — reveal only when done
            }
          } catch { /* malformed SSE chunk — skip */ }
        }
      }
      // Reveal final content all at once (preserve memory entry if present)
      const finalHistory: BoardChatMsg[] = [...newHistory]
      if (memoryEvent) {
        finalHistory.push({ role: 'memory', titles: memoryEvent.titles, decisions: memoryEvent.decisions })
      }
      finalHistory.push({ role: 'assistant', content: assistantContent })
      setBoardChatHistory(finalHistory)
    } catch (err) {
      if (err instanceof Error && err.message === 'AI prompt limit reached') {
        // Modal already opened by fetchWithLimitCheck
      }
      // stream error — silently stop
    }

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
              const readyCount = (project.tasks ?? []).filter(
                (t) => t.is_ready && t.status !== 'done' && t.status !== 'review'
              ).length
              return readyCount > 0 ? (
                <button
                  onClick={() => {
                    if (!githubRepoConnected) {
                      setShowRunReadyRepoGate(true)
                      return
                    }
                    runReadyTasks.mutate()
                  }}
                  disabled={runReadyTasks.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
                  title={`Run all ${readyCount} ready task${readyCount !== 1 ? 's' : ''}`}
                >
                  {runReadyTasks.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                  Run {readyCount} Ready
                </button>
              ) : null
            })()}
            {(() => {
              const executedCount = (project.tasks ?? []).filter(
                (t) => t.status === 'review' && t.agent_dispatched_at
              ).length
              if (executedCount === 0) return null
              const firstExecuted = (project.tasks ?? []).find(
                (t) => t.status === 'review' && t.agent_dispatched_at
              )
              return (
                <button
                  onClick={() => firstExecuted && setSelectedTaskId(firstExecuted.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium transition-colors"
                  title={`${executedCount} task${executedCount !== 1 ? 's' : ''} awaiting validation`}
                >
                  <CheckCircle size={13} />
                  Validate {executedCount} Executed
                </button>
              )
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
              onClick={() => navigate(`/projects/${projectId}/memory`)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-purple-400 hover:bg-gray-800 transition-colors"
              title="Project memory"
            >
              <Brain size={16} />
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

            <div className="flex items-center gap-1 rounded-lg bg-gray-950 border border-gray-800 p-1 w-fit">
              {[
                { id: 'general', label: 'General' },
                { id: 'agents', label: 'Agents' },
                { id: 'team-actors', label: 'Team actors' },
                { id: 'github', label: 'GitHub' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setSettingsTab(tab.id as 'general' | 'agents' | 'team-actors' | 'github')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    settingsTab === tab.id
                      ? 'bg-purple-600 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {settingsTab === 'general' && (
              <>
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
              </>
            )}

            {settingsTab === 'agents' && (
              <div className="border-t border-gray-700 pt-4">
                <div className="mb-3 p-3 rounded-lg border border-gray-800 bg-gray-950/60 space-y-1">
                  <p className="text-xs text-gray-300">
                    <span className="text-purple-300 font-medium">Built-in agents</span> run inside OwnFlow and use each actor's selected model.
                  </p>
                  <p className="text-xs text-gray-500">
                    If an actor is linked to a registered Company agent, tasks for that actor are dispatched to that external endpoint.
                  </p>
                </div>
                <div className="mb-4 p-3 rounded-lg border border-gray-800 bg-gray-950/60 space-y-2">
                  <p className="text-xs text-gray-300 font-medium">How execution works</p>
                  <p className="text-xs text-gray-500">Each actor runs in one of two modes:</p>
                  <div className="grid gap-1 text-xs text-gray-300">
                    <p><span className="text-purple-300 font-medium">Built-in</span> — no webhook URL; OwnFlow runs the task in its internal agent container.</p>
                    <p><span className="text-green-300 font-medium">Webhook</span> — webhook URL set; OwnFlow sends the task to your external agent endpoint.</p>
                  </div>
                  <div className="mt-2 rounded-lg border border-gray-800 bg-gray-900/70 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">Actor execution map</p>
                    <div className="space-y-1.5">
                      {(project.actors ?? []).filter((a) => a.type === 'ai').map((a) => {
                        const src = resolveActorImageSource(a)
                        const img = resolveActorImage(a)
                        const srcLabel = src === 'explicit' ? 'actor' : src === 'role' ? 'role map' : 'default'
                        const chipCls = src === 'explicit'
                          ? 'bg-purple-900/40 text-purple-300 border-purple-700/40'
                          : src === 'role'
                          ? 'bg-blue-900/30 text-blue-300 border-blue-700/40'
                          : 'bg-gray-800 text-gray-400 border-gray-700'
                        return (
                          <div key={`mode-${a.id}`} className="flex items-start justify-between gap-2 text-xs">
                            <div className="min-w-0">
                              <span className="text-gray-200 font-medium truncate block">{a.name}</span>
                              {a.role && <span className="text-gray-500 truncate block">{a.role}</span>}
                            </div>
                            {a.webhook_url ? (
                              <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border text-green-300 border-green-800/60 bg-green-900/20 font-mono">
                                webhook
                              </span>
                            ) : (
                              <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono ${chipCls}`}>
                                <span className="opacity-60">[{srcLabel}]</span>
                                {img}
                              </span>
                            )}
                          </div>
                        )
                      })}

                    </div>
                  </div>
                </div>
                <p className="text-xs text-gray-500">Manage actor roles, teammates, and webhooks in the Team actors tab.</p>
              </div>
            )}

            {settingsTab === 'team-actors' && (
              <div className="border-t border-gray-700 pt-4">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-xs font-medium text-gray-400">Team actors</label>
                <div className="flex gap-2">
                  <button
                    onClick={addHumanTeammate}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-blue-900/40 text-blue-300 hover:bg-blue-900/70 transition-colors"
                  >
                    <User size={11} /> Add teammate
                  </button>
                  <button
                    onClick={() => autoFillActors.mutate()}
                    disabled={autoFillActors.isPending}
                    title="Replace AI actors with the standard default set (human actors preserved)"
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-purple-900/40 text-purple-300 hover:bg-purple-900/70 disabled:opacity-40 transition-colors"
                  >
                    <Zap size={11} />
                    {autoFillActors.isPending ? 'Filling…' : 'Auto-fill AI actors'}
                  </button>
                  <button
                    onClick={() => setShowRolePicker((v) => !v)}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
                  >
                    <Plus size={11} /> Add role
                  </button>
                </div>
              </div>

              {showRolePicker && (
                <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-3">
                  {skills.length === 0 && <p className="text-xs text-gray-500">Loading skills…</p>}
                  {roleCategories.map((cat) => (
                    <div key={cat}>
                      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">{cat}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {skills.filter((s) => s.category === cat).map((skill) => {
                          const hasAI = (project.actors ?? []).some((a) => a.role === skill.name && a.type === 'ai')
                          const hasHuman = (project.actors ?? []).some((a) => a.role === skill.name && a.type === 'human')

                          if (skill.actor_type === 'both') {
                            return (
                              <span key={skill.name} className="inline-flex rounded-md overflow-hidden border border-gray-700 text-xs">
                                <button
                                  type="button"
                                  disabled={hasAI}
                                  onClick={() => addFromTemplate(skill, 'ai')}
                                  className={`flex items-center gap-1 px-2 py-1 transition-colors ${
                                    hasAI ? 'text-gray-600 cursor-default' : 'text-purple-300 hover:bg-purple-900/40'
                                  }`}
                                >
                                  <Bot size={10} />{skill.name}
                                </button>
                                <span className="w-px bg-gray-700" />
                                <button
                                  type="button"
                                  disabled={hasHuman}
                                  onClick={() => addFromTemplate(skill, 'human')}
                                  className={`flex items-center gap-1 px-1.5 py-1 transition-colors ${
                                    hasHuman ? 'text-gray-600 cursor-default' : 'text-blue-300 hover:bg-blue-900/40'
                                  }`}
                                >
                                  <User size={10} />
                                </button>
                              </span>
                            )
                          }

                          const already = skill.actor_type === 'ai' ? hasAI : hasHuman
                          return (
                            <button
                              key={skill.name}
                              type="button"
                              disabled={already}
                              onClick={() => addFromTemplate(skill)}
                              className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors ${
                                already
                                  ? 'border-gray-700 text-gray-600 cursor-default'
                                  : skill.actor_type === 'ai'
                                    ? 'border-purple-700/60 text-purple-300 hover:bg-purple-900/40'
                                    : 'border-blue-700/60 text-blue-300 hover:bg-blue-900/40'
                              }`}
                            >
                              {skill.actor_type === 'ai' ? <Bot size={10} /> : <User size={10} />}
                              {skill.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                {(project.actors ?? []).map((a) => {
                  const isExpanded = !!actorEnvOpen[a.id]
                  const isAi = a.type === 'ai'
                  return (
                    <div
                      key={a.id}
                      className={`bg-gray-950 border rounded-xl overflow-hidden flex flex-col ${
                        isAi ? 'border-purple-900/60' : 'border-blue-900/60'
                      }`}
                    >
                      {/* Card body */}
                      <div className="px-3 pt-3 pb-2 flex-1 space-y-1.5">
                        {/* Icon row */}
                        <div className="flex items-center justify-between">
                          <button
                            type="button"
                            title={isAi ? 'Switch to human' : 'Switch to AI'}
                            onClick={() => isAi
                              ? updateActor.mutate({ actorId: a.id, patch: { type: 'human', model: null } })
                              : updateActor.mutate({ actorId: a.id, patch: { type: 'ai', model: a.model || 'gpt-4o', user_id: null } })
                            }
                            className={`p-1.5 rounded-lg transition-colors ${
                              isAi ? 'bg-purple-900/40 text-purple-400 hover:bg-purple-900/70' : 'bg-blue-900/40 text-blue-400 hover:bg-blue-900/70'
                            }`}
                          >
                            {isAi ? <Bot size={20} /> : <User size={20} />}
                          </button>
                          <button
                            onClick={() => removeActor.mutate(a.id)}
                            disabled={removeActor.isPending}
                            className="text-gray-700 hover:text-red-400 transition-colors"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>

                        {/* Name */}
                        <input
                          type="text"
                          defaultValue={a.name}
                          onBlur={(e) => updateActor.mutate({ actorId: a.id, patch: { name: e.target.value.trim() || a.name } })}
                          placeholder="Name…"
                          className="w-full bg-transparent text-sm font-semibold text-white focus:outline-none placeholder-gray-600 truncate"
                        />

                        {/* Role */}
                        <input
                          list={`role-list-${a.id}`}
                          defaultValue={a.role || ''}
                          onBlur={(e) => updateActor.mutate({ actorId: a.id, patch: { role: e.target.value.trim() || null } })}
                          placeholder="Role…"
                          className={`w-full bg-transparent text-xs focus:outline-none ${
                            !(a.role || '').trim() ? 'text-red-400 placeholder-red-600' : 'text-gray-500 focus:text-gray-200'
                          }`}
                        />
                        <datalist id={`role-list-${a.id}`}>
                          {skills.map((s) => <option key={s.id} value={s.name} />)}
                        </datalist>
                      </div>

                      {/* Card footer */}
                      <div className={`flex items-center justify-between px-3 py-1.5 border-t ${
                        isAi ? 'border-purple-900/40' : 'border-blue-900/40'
                      }`}>
                        {isAi ? (
                          <select
                            value={a.model || 'gpt-4o'}
                            onChange={(e) => updateActor.mutate({ actorId: a.id, patch: { model: e.target.value } })}
                            disabled={updateActor.isPending}
                            className="bg-transparent text-gray-500 text-[11px] focus:outline-none focus:text-gray-300 cursor-pointer max-w-[90px]"
                          >
                            {AI_MODELS.map((m) => (
                              <option key={m.value} value={m.value} className="bg-gray-900">{m.label}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[11px] text-gray-600">human</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (!isExpanded) setActorEnvEdits((prev) => ({ ...prev, [a.id]: envObjToPairs(a.extra_env) }))
                            setActorEnvOpen((prev) => ({ ...prev, [a.id]: !isExpanded }))
                          }}
                          className={`flex items-center gap-1 transition-colors ${isExpanded ? 'text-purple-400' : 'text-gray-600 hover:text-gray-400'}`}
                        >
                          <span className="text-[11px]">Options</span>
                          <ChevronDown size={12} className={`transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                        </button>
                      </div>

                      {/* Expanded config */}
                      {isExpanded && (
                        <div className={`border-t px-3 py-2.5 space-y-2 ${
                          isAi ? 'border-purple-900/40' : 'border-blue-900/40'
                        }`}>
                          {!isAi && (
                            <select
                              value={a.user_id ?? ''}
                              disabled={teamMembersLoading}
                              onChange={(e) => {
                                const uid = e.target.value
                                if (!uid) {
                                  updateActor.mutate({ actorId: a.id, patch: { user_id: null, name: 'Unassigned teammate' } })
                                } else {
                                  const member = teamMembers.find((m) => m.user_id === uid)
                                  updateActor.mutate({ actorId: a.id, patch: { user_id: uid, name: member?.full_name || member?.email || uid } })
                                }
                              }}
                              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none"
                            >
                              <option value="" className="bg-gray-900 text-gray-400">— unassigned —</option>
                              {teamMembers.map((m) => (
                                <option key={m.user_id} value={m.user_id} className="bg-gray-900">
                                  {m.full_name || m.email || m.user_id}
                                </option>
                              ))}
                            </select>
                          )}

                          {isAi && (
                            <>
                              <select
                                value={companyAgents.find((agent) => (agent.webhook_url && agent.webhook_url === a.webhook_url) || (agent.docker_image && agent.docker_image === a.docker_image))?.id || ''}
                                onChange={(e) => updateActor.mutate({ actorId: a.id, patch: { company_agent_id: e.target.value || null } })}
                                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none"
                              >
                                <option value="" className="bg-gray-900 text-gray-400">Built-in</option>
                                {companyAgents.map((agent) => (
                                  <option key={agent.id} value={agent.id} className="bg-gray-900 text-gray-200">
                                    {agent.name}{agent.role ? ` - ${agent.role}` : ''}
                                  </option>
                                ))}
                              </select>
                              {a.webhook_url && (
                                <p className="text-xs text-gray-500 font-mono truncate">{a.webhook_url}</p>
                              )}
                              {!a.webhook_url && (() => {
                                const img = resolveActorImage(a)
                                const src = resolveActorImageSource(a)
                                const srcLabel = src === 'explicit' ? 'actor' : src === 'role' ? 'role map' : 'default'
                                const chipCls = src === 'explicit'
                                  ? 'bg-purple-900/40 text-purple-300 border-purple-700/40'
                                  : src === 'role'
                                  ? 'bg-blue-900/30 text-blue-300 border-blue-700/40'
                                  : 'bg-gray-800 text-gray-400 border-gray-700'
                                return (
                                  <span className={`inline-flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded border ${chipCls}`}>
                                    <span className="opacity-60">[{srcLabel}]</span>
                                    {img}
                                  </span>
                                )
                              })()}
                              <ExtraEnvEditor
                                pairs={actorEnvEdits[a.id] ?? []}
                                onChange={(p) => setActorEnvEdits((prev) => ({ ...prev, [a.id]: p }))}
                                hint="e.g. FIGMA_TOKEN"
                              />
                              <button
                                onClick={() => {
                                  const pairs = actorEnvEdits[a.id] ?? []
                                  const envObj: Record<string, string> = {}
                                  for (const p of pairs) {
                                    if (p.key.trim()) {
                                      envObj[p.key.trim()] = p.isMasked ? '***' : p.value
                                    }
                                  }
                                  const patch = { extra_env: Object.keys(envObj).length > 0 ? envObj : null }
                                  updateActor.mutate({ actorId: a.id, patch })
                                  setActorEnvOpen((prev) => ({ ...prev, [a.id]: false }))
                                }}
                                disabled={updateActor.isPending}
                                className="flex items-center gap-1 px-2 py-1 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-xs rounded-lg"
                              >
                                Save
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              </div>
            )}
            {/* GitHub integration */}
            {settingsTab === 'github' && (
            <div className="border-t border-gray-700 pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <GitBranch size={13} className="text-gray-400" />
                <span className="text-xs font-medium text-gray-400">GitHub integration</span>
                {githubTokenAvailable && (
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${
                    githubFullyConnected
                      ? 'text-green-400 bg-green-900/30 border-green-800/50'
                      : 'text-yellow-400 bg-yellow-900/30 border-yellow-800/50'
                  }`}>{githubFullyConnected ? 'Connected' : 'Token saved — pick a repo'}</span>
                )}
              </div>
              {githubTokenAvailable ? (
                <div className="space-y-3">
                  {/* Show who authenticated — prefer project-level user, fall back to team */}
                  {(githubStatus?.github_user || githubTeamStatus?.github_user) && (
                    <p className="text-xs text-gray-400">
                      {teamGithubConnected && !githubStatus?.github_user
                        ? <>Team GitHub: <span className="text-white font-mono">@{githubTeamStatus!.github_user}</span></>
                        : <>Signed in as <span className="text-white font-mono">@{githubStatus!.github_user}</span></>
                      }
                    </p>
                  )}
                  <p className="text-xs text-gray-500">AI agents will commit code and open PRs to this repo when tasks are executed.</p>

                  {/* Repo selector */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Repository for this project</label>
                    <div className="flex gap-2 items-center flex-wrap">
                      <input
                        placeholder={githubRepos && githubRepos.length > 0 ? 'Search repository…' : 'owner/repo-name'}
                        value={repoInput || githubStatus?.repo || ''}
                        onChange={(e) => setRepoInput(e.target.value)}
                        list={githubRepos && githubRepos.length > 0 ? 'github-repo-options' : undefined}
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                      {githubRepos && githubRepos.length > 0 && (
                        <datalist id="github-repo-options">
                          {githubRepos.map((r) => (
                            <option key={r.full_name} value={r.full_name}>
                              {r.private ? 'private' : 'public'}
                            </option>
                          ))}
                        </datalist>
                      )}
                      <button
                        onClick={() => { const r = (repoInput || githubStatus?.repo || '').trim(); if (r) setRepo.mutate(r) }}
                        disabled={setRepo.isPending || !(repoInput || githubStatus?.repo)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
                      >
                        <LinkIcon size={12} /> {githubStatus?.repo ? 'Change' : 'Set repo'}
                      </button>
                    </div>
                    {githubStatus?.repo && !repoInput && (
                      <p className="text-xs text-gray-500 mt-1">Current: <span className="font-mono text-gray-400">{githubStatus.repo}</span></p>
                    )}
                  </div>

                  {/* Only show disconnect if the project has its own connection */}
                  {githubStatus?.connected && (
                    <button
                      onClick={() => disconnectGithub.mutate()}
                      disabled={disconnectGithub.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 bg-red-900/40 border border-red-800/50 hover:bg-red-800/50 text-red-400 text-sm rounded-lg transition-colors"
                    >
                      <Unlink size={12} /> Disconnect
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    GitHub is not connected for this team yet.
                  </p>
                  <button
                    onClick={() => { if (data?.team_id) window.location.href = `/teams/${data.team_id}/settings` }}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white text-sm rounded-lg transition-colors font-medium"
                  >
                    <GitBranch size={14} />
                    Connect GitHub in Team Settings
                  </button>
                  <p className="text-xs text-gray-600">Connect once — all projects in this team will share the token.</p>
                </div>
              )}
            </div>
            )}
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
            githubConnected={githubRepoConnected}
            githubRepo={githubStatus?.repo ?? null}
            githubTokenAvailable={githubTokenAvailable}
            githubRepos={githubRepos}
            onRepoSet={(repo) => {
              setRepo.mutate(repo, {
                onSuccess: () => {
                  // After repo is set, auto-trigger execution
                  // The TaskDrawer will call doExecute after onRepoSet
                },
              })
            }}
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
                if (m.role === 'memory') {
                  const hasAny = m.titles.length > 0 || m.decisions.length > 0
                  return (
                    <div key={i} className="bg-blue-950/40 border border-blue-800/40 rounded-xl px-3 py-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Brain size={11} className="text-blue-400" />
                        <span className="text-xs text-blue-400 font-medium uppercase tracking-wide">
                          Memory consulted
                        </span>
                        <span className="text-[10px] text-gray-500 ml-auto">
                          {m.titles.length} chunk{m.titles.length === 1 ? '' : 's'}
                          {m.decisions.length > 0 ? `, ${m.decisions.length} decision${m.decisions.length === 1 ? '' : 's'}` : ''}
                        </span>
                      </div>
                      {hasAny ? (
                        <ul className="text-[11px] text-gray-400 space-y-0.5">
                          {m.titles.map((t, j) => (
                            <li key={`t-${j}`} className="truncate">• {t}</li>
                          ))}
                          {m.decisions.map((d, j) => (
                            <li key={`d-${j}`} className="truncate">◆ {d}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-gray-500 italic">No prior memory found for this question.</p>
                      )}
                    </div>
                  )
                }
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
                  // Handle assign_actor separately — it's not a tasks-array intent
                  if (action.intent === 'assign_actor') {
                    const targetTask = (project?.tasks ?? []).find((t) => t.id === action.task_id)
                    return (
                      <div key={i} className="bg-gray-950 border border-gray-700 rounded-xl p-3 space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-blue-400">Assign actor</p>
                        <p className="text-sm text-white">
                          {targetTask?.title ?? action.task_id}
                          <span className="text-gray-400"> → </span>
                          {action.actor_name}
                        </p>
                        <button
                          onClick={() => assignFromBoard.mutate(
                            { taskId: action.task_id, actorId: action.actor_id },
                            { onSuccess: () => setCreatedMsgIndices((prev) => new Set([...prev, i])) },
                          )}
                          disabled={alreadyConfirmed || assignFromBoard.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                          style={alreadyConfirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(59,130,246,0.2)', color: '#93c5fd' }}
                        >
                          {alreadyConfirmed ? 'Assigned ✓' : assignFromBoard.isPending ? 'Assigning…' : 'Assign'}
                        </button>
                      </div>
                    )
                  }

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
              <button
                onClick={() => setShowBoardCommands(true)}
                className="text-gray-500 hover:text-purple-400 transition-colors shrink-0"
                title="Show available commands"
              >
                <HelpCircle size={15} />
              </button>
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

      {showBoardCommands && (
        <AiCommandsModal
          context="board"
          onClose={() => setShowBoardCommands(false)}
          onCommandClick={(example) => setBoardPrompt(example)}
        />
      )}

        {showRunReadyRepoGate && (
          <RepoGateModal
            githubTokenAvailable={githubTokenAvailable}
            githubRepos={githubRepos}
            onRepoSet={(repo) => {
              setRepo.mutate(repo, {
                onSuccess: () => {
                  setShowRunReadyRepoGate(false)
                  runReadyTasks.mutate()
                },
              })
            }}
            onExecuteWithout={() => {
              setShowRunReadyRepoGate(false)
              runReadyTasks.mutate()
            }}
            onCancel={() => setShowRunReadyRepoGate(false)}
          />
        )}
    </div>
  )
}
