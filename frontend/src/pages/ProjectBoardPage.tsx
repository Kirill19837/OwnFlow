import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import api from '../lib/api'
import { useProjectStore } from '../store/projectStore'
import { useRealtimeProject } from '../hooks/useRealtimeProject'
import type { Project, Task } from '../types'
import TaskCard from '../components/TaskCard'
import TaskDrawer from '../components/TaskDrawer'
import { ChevronLeft, Loader2, AlertCircle, Bot, User } from 'lucide-react'
import { format } from 'date-fns'

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
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [activeSprint, setActiveSprint] = useState<string | null>(null)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`).then((r) => r.data),
    enabled: !!projectId,
    refetchInterval: (query) => (query.state.data?.status === 'planning' ? 3000 : false),
  })

  useRealtimeProject(projectId)

  useEffect(() => {
    if (data) {
      setCurrentProject(data)
      if (!activeSprint && data.sprints?.length) {
        setActiveSprint(data.sprints[0].id)
      }
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
        </div>

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
                                onClick={() => setSelectedTask(task)}
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
      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          actors={actors}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  )
}
