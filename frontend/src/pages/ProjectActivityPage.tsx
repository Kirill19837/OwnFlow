import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { ChevronLeft, MessageSquare, ListChecks, Bot, User, Loader2, AlertCircle } from 'lucide-react'
import { format } from 'date-fns'
import AssistantMessage from '../components/AssistantMessage'

interface Interaction {
  id: string
  task_id: string
  task_title: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

interface DecisionGroup {
  task_id: string
  task_title: string
  details: Record<string, string>
}

interface ActivityData {
  interactions: Interaction[]
  decisions: DecisionGroup[]
}

type Tab = 'chat' | 'decisions'

export default function ProjectActivityPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>('chat')
  const [filterTask, setFilterTask] = useState<string>('all')

  // Pre-filter to a specific task if ?task= is in the URL
  useEffect(() => {
    const taskParam = searchParams.get('task')
    if (taskParam) setFilterTask(taskParam)
  }, [searchParams])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['project-activity', projectId],
    queryFn: () => api.get<ActivityData>(`/projects/${projectId}/activity`).then((r) => r.data),
    enabled: !!projectId,
    refetchInterval: 10_000,
  })

  // Project name (fetch minimal)
  const { data: project } = useQuery({
    queryKey: ['project-name', projectId],
    queryFn: () => api.get<{ name: string }>(`/projects/${projectId}`).then((r) => r.data),
    enabled: !!projectId,
  })

  const interactions = data?.interactions ?? []
  const decisions = data?.decisions ?? []

  // Unique tasks that appear in interactions
  const chatTasks = Array.from(
    new Map(interactions.map((i) => [i.task_id, i.task_title])).entries()
  )

  const filteredInteractions =
    filterTask === 'all' ? interactions : interactions.filter((i) => i.task_id === filterTask)

  // Group consecutive messages by task for display
  type Group = { task_id: string; task_title: string; messages: Interaction[] }
  const grouped: Group[] = []
  for (const msg of filteredInteractions) {
    const last = grouped[grouped.length - 1]
    if (last && last.task_id === msg.task_id) {
      last.messages.push(msg)
    } else {
      grouped.push({ task_id: msg.task_id, task_title: msg.task_title, messages: [msg] })
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-gray-800 flex items-center gap-3">
        <button
          onClick={() => navigate(`/projects/${projectId}`)}
          className="text-gray-500 hover:text-white transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <div>
          <h1 className="text-white font-bold text-lg leading-tight">Project Activity</h1>
          {project?.name && (
            <p className="text-gray-500 text-xs mt-0.5">{project.name}</p>
          )}
        </div>

        {/* Tabs */}
        <div className="ml-auto flex items-center bg-gray-900 rounded-lg p-0.5 gap-0.5">
          <button
            onClick={() => setTab('chat')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === 'chat'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <MessageSquare size={13} />
            Chat Log
            {interactions.length > 0 && (
              <span className="text-xs bg-gray-600 rounded-full px-1.5 py-0.5 leading-none">
                {interactions.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('decisions')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === 'decisions'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <ListChecks size={13} />
            Decisions
            {decisions.length > 0 && (
              <span className="text-xs bg-gray-600 rounded-full px-1.5 py-0.5 leading-none">
                {decisions.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5 max-w-4xl w-full mx-auto">
        {isLoading && (
          <div className="flex items-center gap-2 text-gray-400 justify-center mt-20">
            <Loader2 size={18} className="animate-spin" /> Loading activity…
          </div>
        )}
        {isError && (
          <div className="flex items-center gap-2 text-red-400 justify-center mt-20">
            <AlertCircle size={16} /> Failed to load activity.
          </div>
        )}

        {/* ── CHAT TAB ── */}
        {!isLoading && !isError && tab === 'chat' && (
          <>
            {/* Task filter */}
            {chatTasks.length > 1 && (
              <div className="flex items-center gap-2 mb-5 flex-wrap">
                <span className="text-xs text-gray-500">Filter by task:</span>
                <button
                  onClick={() => setFilterTask('all')}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    filterTask === 'all'
                      ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                      : 'border-gray-700 text-gray-400 hover:text-white'
                  }`}
                >
                  All tasks
                </button>
                {chatTasks.map(([id, title]) => (
                  <button
                    key={id}
                    onClick={() => setFilterTask(id)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      filterTask === id
                        ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                        : 'border-gray-700 text-gray-400 hover:text-white'
                    }`}
                  >
                    {title}
                  </button>
                ))}
              </div>
            )}

            {grouped.length === 0 && (
              <div className="text-center text-gray-500 mt-20 text-sm">
                No chat interactions recorded yet.
              </div>
            )}

            <div className="space-y-6">
              {grouped.map((group, gi) => (
                <div key={`${group.task_id}-${gi}`}>
                  {/* Task header */}
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-px flex-1 bg-gray-800" />
                    <button
                      onClick={() => navigate(`/projects/${projectId}?task=${group.task_id}`)}
                      className="text-xs text-gray-400 hover:text-purple-400 transition-colors bg-gray-900 border border-gray-700 px-2.5 py-1 rounded-full"
                    >
                      {group.task_title}
                    </button>
                    <div className="h-px flex-1 bg-gray-800" />
                  </div>

                  {/* Messages */}
                  <div className="space-y-2">
                    {group.messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                      >
                        {/* Avatar */}
                        <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs mt-0.5 ${
                          msg.role === 'assistant'
                            ? 'bg-purple-900 text-purple-300'
                            : 'bg-gray-700 text-gray-300'
                        }`}>
                          {msg.role === 'assistant' ? <Bot size={13} /> : <User size={13} />}
                        </div>

                        <div className={`flex flex-col gap-1 max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                          {msg.role === 'assistant' ? (
                            <AssistantMessage content={msg.content} />
                          ) : (
                            <div className="bg-gray-800 text-gray-100 rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words">
                              {msg.content}
                            </div>
                          )}
                          <span className="text-[10px] text-gray-600">
                            {format(new Date(msg.created_at), 'MMM d, HH:mm')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── DECISIONS TAB ── */}
        {!isLoading && !isError && tab === 'decisions' && (
          <>
            {decisions.length === 0 && (
              <div className="text-center text-gray-500 mt-20 text-sm">
                No decisions captured yet. Use the task chat to refine tasks and save details.
              </div>
            )}

            <div className="space-y-6">
              {decisions.map((group) => (
                <div key={group.task_id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  {/* Task header */}
                  <div className="flex items-center justify-between px-4 py-2.5 bg-gray-800/50 border-b border-gray-700">
                    <button
                      onClick={() => navigate(`/projects/${projectId}?task=${group.task_id}`)}
                      className="text-sm font-medium text-gray-200 hover:text-purple-400 transition-colors text-left"
                    >
                      {group.task_title}
                    </button>
                    <span className="text-xs text-gray-500">
                      {Object.keys(group.details).length} decision{Object.keys(group.details).length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Decision rows */}
                  <div className="divide-y divide-gray-800">
                    {Object.entries(group.details).map(([key, value]) => (
                      <div key={key} className="flex gap-4 px-4 py-2.5">
                        <span className="text-xs text-gray-400 capitalize min-w-[140px] shrink-0 pt-0.5">
                          {key.replace(/_/g, ' ')}
                        </span>
                        <span className="text-sm text-gray-200 break-words">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
