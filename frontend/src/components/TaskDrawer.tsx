import { useState, useRef } from 'react'
import { X, Play, Loader2, Zap } from 'lucide-react'
import type { Task, Actor, Deliverable } from '../types'
import api from '../lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from '../lib/utils'

const STATUS_OPTIONS = ['todo', 'in_progress', 'review', 'done'] as const
const PRIORITY_COLOR: Record<string, string> = {
  low: 'text-gray-400',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
}

interface Props {
  task: Task
  actors: Actor[]
  onClose: () => void
}

export default function TaskDrawer({ task, actors, onClose }: Props) {
  const qc = useQueryClient()
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const { data: deliverables } = useQuery({
    queryKey: ['deliverables', task.id],
    queryFn: () => api.get<Deliverable[]>(`/tasks/${task.id}/deliverables`).then((r) => r.data),
  })

  const assign = useMutation({
    mutationFn: (actor_id: string) =>
      api.patch(`/tasks/${task.id}/assign`, { actor_id: actor_id || '' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const updateStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/tasks/${task.id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const assignedActor = actors.find(
    (a) => a.id === task.assignments?.[0]?.actor_id
  )

  const handleExecute = async () => {
    setStreaming(true)
    setStreamContent('')
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    const res = await fetch(`${baseUrl}/tasks/${task.id}/execute/stream`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value)
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        try {
          const { content } = JSON.parse(payload)
          setStreamContent((p) => p + content)
        } catch {}
      }
    }
    setStreaming(false)
    qc.invalidateQueries({ queryKey: ['deliverables', task.id] })
    qc.invalidateQueries({ queryKey: ['project'] })
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/50" onClick={onClose} />
      {/* Drawer */}
      <div className="w-full max-w-xl bg-gray-950 border-l border-gray-800 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-gray-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={cn('text-xs font-medium uppercase', PRIORITY_COLOR[task.priority])}>
                {task.priority}
              </span>
              <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">{task.type}</span>
            </div>
            <h2 className="text-white font-semibold text-lg leading-tight">{task.title}</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors mt-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Description */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Description</h3>
            <p className="text-gray-300 text-sm leading-relaxed">{task.description}</p>
          </div>

          {/* Status + Assignment */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Status</h3>
              <select
                value={task.status}
                onChange={(e) => updateStatus.mutate(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Assigned to</h3>
              <select
                value={assignedActor?.id ?? ''}
                onChange={(e) => assign.mutate(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="">Unassigned</option>
                {actors.map((a) => {
                  const label = a.role ?? (a.type === 'ai' ? a.model ?? 'AI' : 'Human')
                  return (
                    <option key={a.id} value={a.id}>
                      {a.type === 'ai' ? '🤖' : '👤'} {a.name} · {label}
                    </option>
                  )
                })}
              </select>
            </div>
          </div>

          {/* Start Work */}
          <div>
            <button
              onClick={() => {}}
              className="flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white text-sm px-4 py-2 rounded-lg transition-colors"
            >
              <Zap size={14} />
              Start Work
            </button>
          </div>

          {/* Execute */}
          {assignedActor?.type === 'ai' && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">AI Execution</h3>
              <button
                onClick={handleExecute}
                disabled={streaming}
                className="flex items-center gap-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
              >
                {streaming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {streaming ? 'Executing…' : 'Execute with AI'}
              </button>

              {streaming && streamContent && (
                <div className="mt-3 bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-300 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {streamContent}
                </div>
              )}
            </div>
          )}

          {/* Deliverables */}
          {deliverables && deliverables.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">
                Deliverables ({deliverables.length})
              </h3>
              <div className="space-y-3">
                {deliverables.map((d) => (
                  <div
                    key={d.id}
                    className="bg-gray-900 border border-gray-700 rounded-lg p-4 text-sm text-gray-300 font-mono whitespace-pre-wrap max-h-80 overflow-y-auto"
                  >
                    {d.content}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
