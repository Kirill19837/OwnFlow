import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useProjectStore } from '../store/projectStore'
import { useOrgStore } from '../store/orgStore'
import api from '../lib/api'
import type { Project } from '../types'
import { Plus, Layers, Clock, CheckCircle, AlertCircle, Building2 } from 'lucide-react'
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

  if (!activeOrg) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
        <Building2 size={48} className="text-gray-700" />
        <p className="text-white font-semibold text-lg">No organization selected</p>
        <p className="text-gray-400 text-sm">Create or select an organization from the header to get started.</p>
        <Link to="/orgs/new" className="mt-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
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
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="block bg-gray-900 border border-gray-800 hover:border-purple-600 rounded-xl p-5 transition-all group"
          >
            <div className="flex items-start justify-between mb-3">
              <h2 className="font-semibold text-white group-hover:text-purple-300 transition-colors">
                {p.name}
              </h2>
              <span className="flex items-center gap-1 text-xs text-gray-500 capitalize">
                {STATUS_ICON[p.status]}
                {p.status}
              </span>
            </div>
            <p className="text-gray-400 text-sm line-clamp-2 mb-4">{p.prompt}</p>
            <p className="text-xs text-gray-600">
              {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
