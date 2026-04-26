import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useProjectStore } from '../store/projectStore'
import { useOrgStore } from '../store/orgStore'
import api from '../lib/api'
import type { Project } from '../types'
import { Plus, Layers, Clock, CheckCircle, AlertCircle, Building2, Trash2, RefreshCw } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const STATUS_ICON = {
  planning: <Clock size={14} className="text-yellow-400" />,
  active: <CheckCircle size={14} className="text-green-400" />,
  error: <AlertCircle size={14} className="text-red-400" />,
}

export default function DashboardPage() {
  const { session } = useAuthStore()
  const { setProjects, projects } = useProjectStore()
  const { activeOrg } = useOrgStore()
  const queryClient = useQueryClient()

  // Re-generate log panel state
  const [regenProjectId, setRegenProjectId] = useState<string | null>(null)
  const [regenLogs, setRegenLogs] = useState<string[]>([])
  const [regenError, setRegenError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [regenLogs])

  const { data, isLoading } = useQuery({
    queryKey: ['projects', activeOrg?.id, session?.user.id],
    queryFn: () => {
      const params = activeOrg
        ? { org_id: activeOrg.id }
        : { owner_id: session!.user.id }
      return api.get<Project[]>('/projects', { params }).then((r) => r.data)
    },
    enabled: !!session,
  })

  useEffect(() => {
    if (data) setProjects(data)
  }, [data])

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
    const es = new EventSource(`${apiBase}/projects/${p.id}/plan/stream?ai_model=${encodeURIComponent(activeOrg?.default_ai_model ?? 'gpt-4o')}`)
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

  if (!activeOrg) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
        <Building2 size={48} className="text-gray-700" />
        <p className="text-white font-semibold text-lg">No organization selected</p>
        <p className="text-gray-400 text-sm">Create or select an organization from the header to get started.</p>
        <Link to="/teams/new" className="mt-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          Create organization
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto w-full px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold text-white">{activeOrg.name}</h1>
          <p className="text-xs text-gray-500 mt-0.5">Default model: <span className="text-purple-400">{activeOrg.default_ai_model}</span></p>
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
