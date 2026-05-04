import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useProjectStore } from '../store/projectStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import type { Project } from '../types'
import { Plus, Layers, Clock, CheckCircle, AlertCircle, Building2, Trash2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface TaskActivity {
  task: { id: string; title: string; status: string; priority: string; agent_dispatched_at?: string }
  logs: { id: string; phase: number; message: string; level: number; created_at: string }[]
  latest_response?: string | null
  model?: string | null
}

const LOG_LEVEL_STYLE: Record<number, string> = {
  0: 'text-gray-500',   // debug
  1: 'text-gray-300',   // info
  2: 'text-yellow-400', // warning
  3: 'text-red-400',    // error
}
const LOG_LEVEL_LABEL: Record<number, string> = { 0: 'DBG', 1: 'INF', 2: 'WRN', 3: 'ERR' }
const LOG_PHASE_LABEL: Record<number, string> = {
  0: 'planning', 1: 'exec', 2: 'ext-dispatch', 3: 'docker', 4: 'task-exec',
}

interface ExecutorRunningTask {
  task_id: string
  task_title: string
  project_id: string
  project_name: string
  status: string
  priority: string
  updated_at?: string
  actor_name?: string
  actor_type?: string
}

interface ExecutorState {
  running_count: number
  projects_with_running: number
  running: ExecutorRunningTask[]
  recent_failures: {
    project_id: string
    project_name: string
    phase: string
    message: string
    created_at?: string
  }[]
}

const STATUS_ICON = {
  planning: <Clock size={14} className="text-yellow-400" />,
  active: <CheckCircle size={14} className="text-green-400" />,
  error: <AlertCircle size={14} className="text-red-400" />,
}

export default function DashboardPage() {
  const { session } = useAuthStore()
  const { setProjects, projects } = useProjectStore()
  const { activeTeam } = useTeamStore()
  const queryClient = useQueryClient()

  // Re-generate log panel state
  const [regenProjectId, setRegenProjectId] = useState<string | null>(null)
  const [regenLogs, setRegenLogs] = useState<string[]>([])
  const [regenError, setRegenError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [monitorOpen, setMonitorOpen] = useState(false)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [regenLogs])

  const { data, isLoading } = useQuery({
    queryKey: ['projects', activeTeam?.id, session?.user.id],
    queryFn: () => {
      const params = activeTeam
        ? { team_id: activeTeam.id }
        : { owner_id: session!.user.id }
      return api.get<Project[]>('/projects', { params }).then((r) => r.data)
    },
    enabled: !!session,
  })

  const { data: executorState, isFetching: executorRefreshing } = useQuery({
    queryKey: ['executor-state', activeTeam?.id, session?.user.id],
    queryFn: () => {
      const params = activeTeam
        ? { team_id: activeTeam.id }
        : { owner_id: session!.user.id }
      return api.get<ExecutorState>('/projects/dashboard/executor-state', { params }).then((r) => r.data)
    },
    enabled: !!session,
    refetchInterval: 8000,
  })

  // Expanded task activity — auto-refresh while open
  const expandedTask = (executorState?.running ?? []).find((t) => t.task_id === expandedTaskId)
  const { data: taskActivity } = useQuery<TaskActivity>({
    queryKey: ['task-activity', expandedTaskId],
    queryFn: () =>
      api
        .get<TaskActivity>(`/projects/${expandedTask!.project_id}/tasks/${expandedTaskId}/activity`)
        .then((r) => r.data),
    enabled: !!expandedTaskId && !!expandedTask,
    refetchInterval: 5000,
  })

  const rerunTask = useMutation({
    mutationFn: (task_id: string) => api.post(`/tasks/${task_id}/execute`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executor-state'] })
      queryClient.invalidateQueries({ queryKey: ['task-activity', expandedTaskId] })
    },
  })

  useEffect(() => {
    if (data) setProjects(data)
  }, [data, setProjects])

  const deleteProject = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const startRegen = async (p: Project) => {
    setRegenError(null)
    setRegenLogs([`🔄 Wiping existing plan for "${p.name}"…`])
    setRegenProjectId(p.id)
    await api.post(`/projects/${p.id}/regenerate`)
    setRegenLogs((prev) => [...prev, '🚀 Re-running plan generation…'])
    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    const es = new EventSource(`${apiBase}/projects/${p.id}/plan/stream?ai_model=${encodeURIComponent(activeTeam?.default_ai_model ?? 'gpt-4o')}`)
    esRef.current = es
    es.onmessage = (e) => {
      const payload = JSON.parse(e.data)
      if (payload.type === 'log') {
        setRegenLogs((prev) => [...prev, payload.message])
      } else if (payload.type === 'done') {
        es.close()
        setRegenLogs((prev) => [...prev, '🏁 Done!'])
        queryClient.invalidateQueries({ queryKey: ['projects'] })
        setTimeout(() => setRegenProjectId(null), 1200)
      } else if (payload.type === 'error') {
        setRegenError(payload.message)
        setRegenLogs((prev) => [...prev, `❌ ${payload.message}`])
        es.close()
      }
    }
    es.onerror = () => {
      setRegenError('Connection lost.')
      setRegenLogs((prev) => [...prev, '❌ Connection lost.'])
      es.close()
    }
  }

  if (!activeTeam) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
        <Building2 size={48} className="text-gray-700" />
        <p className="text-white font-semibold text-lg">No team selected</p>
        <p className="text-gray-400 text-sm">Create or select a team from the header to get started.</p>
        <Link to="/teams/new" className="mt-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          Create team
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto w-full px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold text-white">{activeTeam.name}</h1>
          <p className="text-xs text-gray-500 mt-0.5">Default model: <span className="text-purple-400">{activeTeam.default_ai_model}</span></p>
        </div>
        <Link
          to="/new"
          className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          New Project
        </Link>
      </div>

      {isLoading && (
        <div className="text-gray-400 text-sm">Loading projects…</div>
      )}

      {!isLoading && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Layers size={48} className="text-gray-700 mb-4" />
          <p className="text-gray-400">No projects yet.</p>
          <Link to="/new" className="mt-4 text-purple-400 hover:underline text-sm">
            Create your first project →
          </Link>
        </div>
      )}

      {/* ── Executor Monitor (collapsible) ────────────────────────────── */}
      <div className="mb-5 rounded-xl border border-gray-800 bg-gray-900/70 overflow-hidden">
        {/* Summary bar — always visible */}
        <button
          onClick={() => setMonitorOpen((v) => !v)}
          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/60 transition-colors"
        >
          <span className="text-xs font-medium text-gray-400">Executor</span>
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            (executorState?.running_count ?? 0) > 0
              ? 'border-yellow-700/50 bg-yellow-900/20 text-yellow-300'
              : 'border-gray-700 bg-gray-800/60 text-gray-500'
          }`}>
            {executorState?.running_count ?? 0} running
          </span>
          {(executorState?.recent_failures?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-800/60 bg-red-900/20 px-2 py-0.5 text-[11px] font-medium text-red-400">
              {executorState!.recent_failures.length} failure{executorState!.recent_failures.length !== 1 ? 's' : ''}
            </span>
          )}
          {executorRefreshing && <span className="text-[11px] text-gray-600 ml-1">↻</span>}
          <span className="ml-auto text-gray-600">{monitorOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
        </button>

        {/* Expanded detail */}
        {monitorOpen && (
          <div className="border-t border-gray-800 p-3 space-y-2">
            {(executorState?.running?.length ?? 0) === 0 ? (
              <p className="text-xs text-gray-500 px-1">No executor jobs are currently running.</p>
            ) : (
              (executorState?.running ?? []).slice(0, 8).map((item) => {
                const isExpanded = expandedTaskId === item.task_id
                return (
                  <div key={item.task_id} className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-900 transition-colors"
                      onClick={() => setExpandedTaskId(isExpanded ? null : item.task_id)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{item.task_title}</p>
                        <p className="text-[11px] text-gray-500">
                          {item.project_name} · {item.actor_name || 'Unassigned'}
                          {item.updated_at && ` · ${formatDistanceToNow(new Date(item.updated_at), { addSuffix: true })}`}
                        </p>
                      </div>
                      <Link
                        to={`/projects/${item.project_id}?task=${item.task_id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-gray-600 hover:text-purple-400 text-xs shrink-0"
                      >→</Link>
                      <button
                        title="Re-run task"
                        onClick={(e) => { e.stopPropagation(); rerunTask.mutate(item.task_id) }}
                        disabled={rerunTask.isPending}
                        className="text-gray-600 hover:text-yellow-400 transition-colors disabled:opacity-40 shrink-0"
                      >
                        <RefreshCw size={12} className={rerunTask.isPending && rerunTask.variables === item.task_id ? 'animate-spin' : ''} />
                      </button>
                      {isExpanded ? <ChevronUp size={12} className="text-gray-600 shrink-0" /> : <ChevronDown size={12} className="text-gray-600 shrink-0" />}
                    </div>
                    {isExpanded && (
                      <div className="border-t border-gray-800 px-3 py-2 space-y-2">
                        {!taskActivity ? (
                          <p className="text-xs text-gray-500 animate-pulse">Loading activity…</p>
                        ) : (
                          <>
                            {taskActivity.logs.length === 0 ? (
                              <p className="text-xs text-gray-500">No log entries yet since dispatch.</p>
                            ) : (
                              <div className="space-y-0.5 max-h-40 overflow-y-auto font-mono text-[11px]">
                                {taskActivity.logs.map((log) => (
                                  <div key={log.id} className="flex gap-2 leading-snug">
                                    <span className="text-gray-600 shrink-0">{new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                    <span className={`shrink-0 w-8 ${LOG_LEVEL_STYLE[log.level] ?? 'text-gray-400'}`}>{LOG_LEVEL_LABEL[log.level] ?? log.level}</span>
                                    <span className="text-gray-500 shrink-0 w-20 truncate">{LOG_PHASE_LABEL[log.phase] ?? log.phase}</span>
                                    <span className={LOG_LEVEL_STYLE[log.level] ?? 'text-gray-300'}>{log.message}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {taskActivity.latest_response && (
                              <div className="border-t border-gray-800 pt-2">
                                <p className="text-[11px] text-gray-500 mb-1">Latest AI response{taskActivity.model ? ` (${taskActivity.model})` : ''}</p>
                                <p className="text-xs text-gray-300 whitespace-pre-wrap line-clamp-5">{taskActivity.latest_response}</p>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            {(executorState?.recent_failures?.length ?? 0) > 0 && (
              <div className="pt-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-red-400 mb-1.5 px-1">Recent Failures</p>
                <div className="space-y-1.5">
                  {(executorState?.recent_failures ?? []).map((failure, idx) => (
                    <Link
                      key={`${failure.project_id}-${failure.created_at ?? idx}`}
                      to={`/projects/${failure.project_id}`}
                      className="block rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-1.5 hover:border-red-700 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs text-red-100 leading-tight truncate">{failure.message}</p>
                        <span className="text-[10px] uppercase rounded-full border border-red-800/70 px-1.5 py-0.5 text-red-300 shrink-0">{failure.phase}</span>
                      </div>
                      <p className="text-[11px] text-red-300/60 mt-0.5">
                        {failure.project_name}{failure.created_at ? ` · ${formatDistanceToNow(new Date(failure.created_at), { addSuffix: true })}` : ''}
                      </p>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <div key={p.id} className="relative group bg-gray-900 border border-gray-800 hover:border-purple-600 rounded-xl p-5 transition-all">
            {/* Action buttons — visible on hover */}
            <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                title="Re-generate plan"
                onClick={(e) => { e.preventDefault(); startRegen(p) }}
                className="p-1.5 rounded-lg bg-gray-800 hover:bg-yellow-900/60 text-gray-400 hover:text-yellow-300 transition-colors"
              >
                <RefreshCw size={13} />
              </button>
              <button
                title="Delete project"
                onClick={(e) => {
                  e.preventDefault()
                  if (confirm(`Delete "${p.name}"? This cannot be undone.`)) deleteProject.mutate(p.id)
                }}
                className="p-1.5 rounded-lg bg-gray-800 hover:bg-red-900/60 text-gray-400 hover:text-red-400 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>

            <Link to={`/projects/${p.id}`} className="block">
              <div className="flex items-start justify-between mb-3 pr-14">
                <h2 className="font-semibold text-white group-hover:text-purple-300 transition-colors">
                  {p.name}
                </h2>
                <span className="flex items-center gap-1 text-xs text-gray-500 capitalize shrink-0">
                  {STATUS_ICON[p.status as keyof typeof STATUS_ICON]}
                  {p.status}
                </span>
              </div>
              <p className="text-gray-400 text-sm line-clamp-2 mb-4">{p.prompt}</p>
              <p className="text-xs text-gray-600">
                {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
              </p>
            </Link>
          </div>
        ))}
      </div>

      {/* Re-generate log panel */}
      {regenProjectId && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end justify-center z-50 p-4">
          <div className="w-full max-w-2xl bg-gray-950 border border-gray-700 rounded-xl shadow-2xl flex flex-col" style={{ maxHeight: '70vh' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <span className="text-sm font-mono font-semibold text-yellow-300">Re-generating Plan</span>
              {regenError && (
                <button onClick={() => setRegenProjectId(null)} className="text-xs text-gray-500 hover:text-gray-300">Close</button>
              )}
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 font-mono text-xs space-y-1">
              {regenLogs.map((line, i) => (
                <div key={i} className="text-gray-300 leading-relaxed">
                  <span className="text-gray-600 mr-2 select-none">{String(i + 1).padStart(2, '0')}</span>
                  {line}
                </div>
              ))}
              {!regenError && regenLogs.length > 0 && !regenLogs[regenLogs.length - 1].startsWith('🏁') && (
                <div className="flex items-center gap-1.5 text-gray-500">
                  <span className="animate-pulse">●</span> Working…
                </div>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
