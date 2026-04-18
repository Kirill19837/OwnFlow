import { useState, useRef } from 'react'
import { X, Play, Loader2, Zap, Send, Bot, CheckCircle, UserCheck, RefreshCw } from 'lucide-react'
import type { Task, Actor, Deliverable } from '../types'
import api from '../lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from '../lib/utils'

const STATUS_OPTIONS = ['todo', 'in_progress', 'review', 'done', 'rework'] as const

const WORKFLOW: Record<string, string> = {
  todo: 'in_progress',
  in_progress: 'review',
  review: 'done',
  done: 'done',
  rework: 'in_progress',
}
const PRIORITY_COLOR: Record<string, string> = {
  low: 'text-gray-400',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
}

type TaskAction =
  | { intent: 'assign_actor'; actor_id: string; actor_name: string }
  | { intent: 'update_status'; status: string }
  | { intent: 'execute_task'; confirm: boolean }

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

  // Chat state
  const [promptInput, setPromptInput] = useState('')
  const [promptStreaming, setPromptStreaming] = useState(false)
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [confirmedIndices, setConfirmedIndices] = useState<Set<number>>(new Set())
  const promptAbortRef = useRef<AbortController | null>(null)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)

  const { data: deliverables } = useQuery({
    queryKey: ['deliverables', task.id],
    queryFn: () => api.get<Deliverable[]>(`/tasks/${task.id}/deliverables`).then((r) => r.data),
  })

  const assign = useMutation({
    mutationFn: (actor_id: string) =>
      api.patch(`/tasks/${task.id}/assign`, { actor_id: actor_id || '' }),
    onSuccess: (response) => {
      const assignment = response.data
      qc.setQueryData(['project', task.project_id], (old: any) => {
        if (!old) return old
        return {
          ...old,
          tasks: (old.tasks ?? []).map((t: any) =>
            t.id === task.id
              ? { ...t, assignments: assignment?.actor_id ? [assignment] : [] }
              : t
          ),
        }
      })
      qc.invalidateQueries({ queryKey: ['project', task.project_id] })
    },
  })

  const updateStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/tasks/${task.id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const assignedActor = actors.find((a) => {
    const a0 = Array.isArray(task.assignments)
      ? task.assignments[0]
      : (task.assignments as any)
    return a.id === a0?.actor_id
  })

  function parseTaskAction(content: string): TaskAction | null {
    const m = content.match(/```json\s*([\s\S]*?)```/)
    if (!m) return null
    try {
      const parsed = JSON.parse(m[1].trim())
      if (['assign_actor', 'update_status', 'execute_task'].includes(parsed.intent)) {
        return parsed as TaskAction
      }
    } catch {}
    return null
  }

  const handlePrompt = async () => {
    const msg = promptInput.trim()
    if (!msg || promptStreaming) return
    setPromptInput('')
    setPromptStreaming(true)

    const userMsg: { role: 'user' | 'assistant'; content: string } = { role: 'user', content: msg }
    const newHistory = [...chatHistory, userMsg]
    // Silent buffer — show thinking spinner
    setChatHistory([...newHistory, { role: 'assistant', content: '' }])

    const ctrl = new AbortController()
    promptAbortRef.current = ctrl
    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetch(`${baseUrl}/tasks/${task.id}/prompt/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg, history: chatHistory }),
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
            // Don't reveal mid-stream
          } catch {}
        }
      }
      setChatHistory([...newHistory, { role: 'assistant', content: assistantContent }])
    } catch {}

    setPromptStreaming(false)
    setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

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

  const confirmAction = (action: TaskAction, idx: number) => {
    if (action.intent === 'assign_actor') {
      assign.mutate(action.actor_id, {
        onSuccess: () => setConfirmedIndices((p) => new Set([...p, idx])),
      })
    } else if (action.intent === 'update_status') {
      updateStatus.mutate(action.status, {
        onSuccess: () => setConfirmedIndices((p) => new Set([...p, idx])),
      })
    } else if (action.intent === 'execute_task') {
      handleExecute()
      setConfirmedIndices((p) => new Set([...p, idx]))
    }
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
              onClick={() => {
                const next = WORKFLOW[task.status]
                if (next && next !== task.status) updateStatus.mutate(next)
              }}
              disabled={task.status === 'done' || updateStatus.isPending}
              className="flex items-center gap-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg transition-colors"
            >
              <Zap size={14} />
              {task.status === 'todo' && 'Start Work'}
              {task.status === 'in_progress' && 'Submit for Review'}
              {task.status === 'review' && 'Mark Done'}
              {task.status === 'done' && 'Done ✓'}
              {task.status === 'rework' && 'Resume Work'}
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

        {/* Agent chat — pinned at bottom */}
        <div className="border-t border-gray-800 bg-gray-950 flex flex-col" style={{ maxHeight: '55%' }}>
          {/* Agent header */}
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <Bot size={13} className="text-purple-400" />
            <span className="text-xs text-purple-400 font-medium">
              {assignedActor ? `${assignedActor.name}` : 'AI Assistant'}
            </span>
            {assignedActor && (
              <span className="text-xs text-gray-600">
                · {assignedActor.role || assignedActor.model || assignedActor.type}
              </span>
            )}
            {chatHistory.length > 0 && (
              <button
                onClick={() => { setChatHistory([]); setConfirmedIndices(new Set()) }}
                className="ml-auto text-gray-600 hover:text-gray-400 text-xs"
              >
                Clear
              </button>
            )}
          </div>

          {/* Chat messages */}
          {chatHistory.length > 0 && (
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0">
              {chatHistory.map((m, i) => {
                const isThinking = promptStreaming && i === chatHistory.length - 1 && m.role === 'assistant'
                const action = m.role === 'assistant' && !isThinking && m.content ? parseTaskAction(m.content) : null
                const confirmed = confirmedIndices.has(i)

                if (isThinking) {
                  return (
                    <div key={i} className="flex items-center gap-2 text-purple-400 text-sm py-1">
                      <Loader2 size={13} className="animate-spin" />
                      <span className="opacity-70 text-xs">
                        {assignedActor ? `${assignedActor.name} is thinking…` : 'Thinking…'}
                      </span>
                    </div>
                  )
                }

                if (action) {
                  if (action.intent === 'assign_actor') {
                    const target = actors.find(a => a.id === action.actor_id)
                    return (
                      <div key={i} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                        <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide">Assign task</p>
                        <p className="text-sm text-white">
                          {target ? `${target.type === 'ai' ? '🤖' : '👤'} ${target.name}` : action.actor_name}
                          {target?.role && <span className="text-gray-400 text-xs ml-1">· {target.role}</span>}
                        </p>
                        <button
                          onClick={() => confirmAction(action, i)}
                          disabled={confirmed || assign.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(59,130,246,0.2)', color: '#93c5fd' }}
                        >
                          {confirmed ? <><CheckCircle size={11} /> Assigned</> : assign.isPending ? <><Loader2 size={11} className="animate-spin" /> Assigning…</> : <><UserCheck size={11} /> Assign</>}
                        </button>
                      </div>
                    )
                  }

                  if (action.intent === 'update_status') {
                    return (
                      <div key={i} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                        <p className="text-xs text-yellow-400 font-semibold uppercase tracking-wide">Update status</p>
                        <p className="text-sm text-white">{task.status} → <span className="font-semibold">{action.status.replace('_', ' ')}</span></p>
                        <button
                          onClick={() => confirmAction(action, i)}
                          disabled={confirmed || updateStatus.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(234,179,8,0.15)', color: '#facc15' }}
                        >
                          {confirmed ? <><CheckCircle size={11} /> Done</> : updateStatus.isPending ? <><Loader2 size={11} className="animate-spin" /> Updating…</> : <><RefreshCw size={11} /> Apply</>}
                        </button>
                      </div>
                    )
                  }

                  if (action.intent === 'execute_task') {
                    return (
                      <div key={i} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                        <p className="text-xs text-purple-400 font-semibold uppercase tracking-wide">Execute task</p>
                        <p className="text-sm text-gray-300">Run AI execution for this task</p>
                        <button
                          onClick={() => confirmAction(action, i)}
                          disabled={confirmed || streaming}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(168,85,247,0.2)', color: '#c084fc' }}
                        >
                          {confirmed ? <><CheckCircle size={11} /> Started</> : streaming ? <><Loader2 size={11} className="animate-spin" /> Running…</> : <><Play size={11} /> Execute</>}
                        </button>
                      </div>
                    )
                  }
                }

                // Plain message
                return (
                  <div key={i} className={cn('text-sm rounded-lg px-3 py-2 whitespace-pre-wrap', m.role === 'user' ? 'bg-gray-800 text-gray-200 self-end text-right' : 'bg-gray-900 text-gray-300')}>
                    {m.content}
                  </div>
                )
              })}
              <div ref={chatBottomRef} />
            </div>
          )}

          {/* Input */}
          <div className="flex gap-2 items-end px-4 pb-4 pt-2">
            <textarea
              rows={1}
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePrompt() } }}
              placeholder={assignedActor ? `Ask ${assignedActor.name}…` : 'Ask AI about this task…'}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
            />
            <button
              onClick={handlePrompt}
              disabled={!promptInput.trim() || promptStreaming}
              className="p-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg transition-colors shrink-0"
            >
              {promptStreaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
