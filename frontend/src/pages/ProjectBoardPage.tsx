import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import api from '../lib/api'
import { useProjectStore } from '../store/projectStore'
import { useRealtimeProject } from '../hooks/useRealtimeProject'
import type { Project, Task } from '../types'
import TaskCard from '../components/TaskCard'
import TaskDrawer from '../components/TaskDrawer'
import { ChevronLeft, Loader2, AlertCircle, Bot, User, Sparkles, Settings2, X, Plus, Trash2 } from 'lucide-react'
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
] as const

export default function ProjectBoardPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { currentProject, setCurrentProject } = useProjectStore()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeSprint, setActiveSprint] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsName, setSettingsName] = useState('')
  const [settingsPrompt, setSettingsPrompt] = useState('')
  const [settingsSprintDays, setSettingsSprintDays] = useState<number>(3)
  // New actor form state
  const [newActorName, setNewActorName] = useState('')
  const [newActorRole, setNewActorRole] = useState('')
  const [newActorType, setNewActorType] = useState<'ai' | 'human'>('ai')
  const [newActorModel, setNewActorModel] = useState('gpt-4o')

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`).then((r) => r.data),
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
    </div>
  )
}
