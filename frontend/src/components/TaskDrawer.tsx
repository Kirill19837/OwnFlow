import { useState, useRef, useEffect } from 'react'
import { X, Play, Loader2, Zap, Send, Bot, CheckCircle, UserCheck, RefreshCw, FileText, Sparkles, ChevronDown } from 'lucide-react'
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
  | { intent: 'update_description'; content: string }

// Chat message types
type ChatMsg =
  | { kind: 'user'; content: string }
  | { kind: 'assistant'; content: string }
  | { kind: 'plan'; content: string }
  | { kind: 'deliverable'; content: string; actorName: string }
  | { kind: 'thinking' }

interface Props {
  task: Task
  actors: Actor[]
  onClose: () => void
}

export default function TaskDrawer({ task, actors, onClose }: Props) {
  const qc = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)

  // Unified chat log — user msgs, agent replies, plans, deliverables
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [chatOpen, setChatOpen] = useState(true)
  const [promptInput, setPromptInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [confirmedIndices, setConfirmedIndices] = useState<Set<number>>(new Set())
  const chatBottomRef = useRef<HTMLDivElement | null>(null)

  const scrollBottom = () => setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  const { data: deliverables } = useQuery({
    queryKey: ['deliverables', task.id],
    queryFn: () => api.get<Deliverable[]>(`/tasks/${task.id}/deliverables`).then((r) => r.data),
  })

  // Inject persisted deliverables into chat on first load
  useEffect(() => {
    if (deliverables && deliverables.length > 0 && chat.length === 0) {
      const actorName = assignedActor?.name ?? 'Agent'
      setChat(deliverables.map((d) => ({ kind: 'deliverable' as const, content: d.content, actorName })))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliverables])

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

  const updateDescription = useMutation({
    mutationFn: (content: string) => api.patch(`/tasks/${task.id}/description`, { content }),
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
      if (['assign_actor', 'update_status', 'execute_task', 'update_description'].includes(parsed.intent)) {
        return parsed as TaskAction
      }
    } catch {}
    return null
  }

  const handlePrompt = async () => {
    const msg = promptInput.trim()
    if (!msg || isStreaming) return
    setPromptInput('')
    setIsStreaming(true)

    // Snapshot history for backend (only user+assistant messages)
    const historyForBackend = chat
      .filter((m) => m.kind === 'user' || m.kind === 'assistant')
      .map((m) => ({ role: m.kind as 'user' | 'assistant', content: (m as any).content as string }))

    setChat((prev) => [...prev, { kind: 'user', content: msg }, { kind: 'thinking' }])
    scrollBottom()

    const ctrl = new AbortController()
    abortRef.current = ctrl
    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetch(`${baseUrl}/tasks/${task.id}/prompt/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg, history: historyForBackend }),
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
          } catch {}
        }
      }
      setChat((prev) => [
        ...prev.filter((m) => m.kind !== 'thinking'),
        { kind: 'assistant', content: assistantContent },
      ])
    } catch {
      setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
    }

    setIsStreaming(false)
    scrollBottom()
  }

  const handleExecute = async () => {
    if (isStreaming) return
    setIsStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const actorName = assignedActor?.name ?? 'Agent'

    setChat((prev) => [...prev, { kind: 'thinking' }])
    scrollBottom()

    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetch(`${baseUrl}/tasks/${task.id}/execute/stream`, { signal: ctrl.signal })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let planShown = false
      let deliverableContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') break
          try {
            const evt = JSON.parse(payload)
            if (evt.type === 'plan') {
              setChat((prev) => [
                ...prev.filter((m) => m.kind !== 'thinking'),
                { kind: 'plan', content: evt.content },
              ])
              planShown = true
              scrollBottom()
            } else if (evt.type === 'content') {
              deliverableContent += evt.content
            } else if (evt.content) {
              // legacy fallback (no type field)
              deliverableContent += evt.content
            }
          } catch {}
        }
      }

      // Show deliverable as a chat card
      if (deliverableContent) {
        setChat((prev) => [
          ...prev.filter((m) => m.kind !== 'thinking'),
          ...(planShown ? [] : []),
          { kind: 'deliverable', content: deliverableContent, actorName },
        ])
      } else {
        setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
      }
    } catch {
      setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
    }

    setIsStreaming(false)
    qc.invalidateQueries({ queryKey: ['deliverables', task.id] })
    qc.invalidateQueries({ queryKey: ['project'] })
    scrollBottom()
  }

  const confirmAction = (action: TaskAction, idx: number) => {
    const markDone = () => setConfirmedIndices((p) => new Set([...p, idx]))
    if (action.intent === 'assign_actor') {
      assign.mutate(action.actor_id, { onSuccess: markDone })
    } else if (action.intent === 'update_status') {
      updateStatus.mutate(action.status, { onSuccess: markDone })
    } else if (action.intent === 'update_description') {
      updateDescription.mutate(action.content, { onSuccess: markDone })
    } else if (action.intent === 'execute_task') {
      handleExecute()
      markDone()
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
              <button
                onClick={handleExecute}
                disabled={isStreaming}
                className="flex items-center gap-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
              >
                {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {isStreaming ? 'Executing…' : 'Execute with AI'}
              </button>
            </div>
          )}
        </div>

        {/* Agent chat — unified log */}
        <div className="border-t border-gray-800 bg-gray-950 flex flex-col" style={chatOpen ? { maxHeight: '60%' } : {}}>
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2 shrink-0 select-none">
            <Bot size={13} className="text-purple-400" />
            <span className="text-xs text-purple-400 font-medium">
              {assignedActor ? assignedActor.name : 'AI Assistant'}
            </span>
            {assignedActor && (
              <span className="text-xs text-gray-600">
                · {assignedActor.role || assignedActor.model || assignedActor.type}
              </span>
            )}
            {chatOpen && chat.length > 0 && (
              <button
                onClick={() => { setChat([]); setConfirmedIndices(new Set()) }}
                className="text-gray-600 hover:text-gray-400 text-xs"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setChatOpen((open) => !open)}
              className="ml-auto text-gray-500 hover:text-gray-300 transition-colors"
              title={chatOpen ? 'Collapse Copilot' : 'Expand Copilot'}
            >
              <ChevronDown size={13} className={`transition-transform ${chatOpen ? '' : '-rotate-90'}`} />
            </button>
          </div>

          {/* Message log */}
          {chatOpen && <><div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0">
            {chat.length === 0 && (
              <p className="text-xs text-gray-700 py-2">
                {assignedActor ? `Ask ${assignedActor.name} anything about this task, or type "execute" to run it.` : 'Ask AI about this task…'}
              </p>
            )}
            {chat.map((m, i) => {
              if (m.kind === 'thinking') {
                return (
                  <div key={i} className="flex items-center gap-2 text-purple-400 text-sm py-1">
                    <Loader2 size={13} className="animate-spin" />
                    <span className="opacity-70 text-xs">
                      {assignedActor ? `${assignedActor.name} is thinking…` : 'Thinking…'}
                    </span>
                  </div>
                )
              }

              if (m.kind === 'plan') {
                return (
                  <div key={i} className="bg-purple-950/40 border border-purple-800/50 rounded-xl px-3 py-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Sparkles size={11} className="text-purple-400" />
                      <span className="text-xs text-purple-400 font-medium uppercase tracking-wide">Execution plan</span>
                    </div>
                    <p className="text-xs text-gray-300 whitespace-pre-wrap">{m.content}</p>
                  </div>
                )
              }

              if (m.kind === 'deliverable') {
                return (
                  <div key={i} className="bg-gray-900 border border-green-800/40 rounded-xl px-3 py-2">
                    <div className="flex items-center gap-1.5 mb-2">
                      <FileText size={11} className="text-green-400" />
                      <span className="text-xs text-green-400 font-medium uppercase tracking-wide">
                        Result · {m.actorName}
                      </span>
                    </div>
                    <div className="text-xs text-gray-300 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto pr-1">
                      {m.content}
                    </div>
                  </div>
                )
              }

              if (m.kind === 'assistant') {
                const action = parseTaskAction(m.content)
                const confirmed = confirmedIndices.has(i)

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
                        <button onClick={() => confirmAction(action, i)} disabled={confirmed || assign.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(59,130,246,0.2)', color: '#93c5fd' }}>
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
                        <button onClick={() => confirmAction(action, i)} disabled={confirmed || updateStatus.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(234,179,8,0.15)', color: '#facc15' }}>
                          {confirmed ? <><CheckCircle size={11} /> Done</> : updateStatus.isPending ? <><Loader2 size={11} className="animate-spin" /> Updating…</> : <><RefreshCw size={11} /> Apply</>}
                        </button>
                      </div>
                    )
                  }
                  if (action.intent === 'update_description') {
                    return (
                      <div key={i} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                        <p className="text-xs text-teal-400 font-semibold uppercase tracking-wide">Update task documentation</p>
                        <div className="text-xs text-gray-300 bg-gray-950 rounded-lg px-2 py-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
                          {action.content.slice(0, 300)}{action.content.length > 300 ? '…' : ''}
                        </div>
                        <button onClick={() => confirmAction(action, i)} disabled={confirmed || updateDescription.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(20,184,166,0.15)', color: '#2dd4bf' }}>
                          {confirmed ? <><CheckCircle size={11} /> Saved</> : updateDescription.isPending ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <><FileText size={11} /> Save to task</>}
                        </button>
                      </div>
                    )
                  }
                  if (action.intent === 'execute_task') {
                    return (
                      <div key={i} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                        <p className="text-xs text-purple-400 font-semibold uppercase tracking-wide">Execute task</p>
                        <p className="text-sm text-gray-300">Run AI execution for this task</p>
                        <button onClick={() => confirmAction(action, i)} disabled={confirmed || isStreaming}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                          style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(168,85,247,0.2)', color: '#c084fc' }}>
                          {confirmed ? <><CheckCircle size={11} /> Started</> : isStreaming ? <><Loader2 size={11} className="animate-spin" /> Running…</> : <><Play size={11} /> Execute</>}
                        </button>
                      </div>
                    )
                  }
                }

                return (
                  <div key={i} className="bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap">
                    {m.content}
                  </div>
                )
              }

              // user message
              return (
                <div key={i} className="bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 text-right whitespace-pre-wrap self-end">
                  {m.content}
                </div>
              )
            })}
            <div ref={chatBottomRef} />
          </div>

          {/* Input */}
          <div className="flex gap-2 items-end px-4 pb-4 pt-2 shrink-0">
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
              disabled={!promptInput.trim() || isStreaming}
              className="p-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg transition-colors shrink-0"
            >
              {isStreaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div></>
        }
        </div>
      </div>
    </div>
  )
}
