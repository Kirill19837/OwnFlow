import { useState, useRef, useEffect } from 'react'
import { X, Play, Loader2, Zap, Send, Bot, CheckCircle, UserCheck, RefreshCw, FileText, Sparkles, ChevronDown, CheckCircle2, ListChecks } from 'lucide-react'
import type { Task, Actor, Deliverable, TaskInteraction } from '../types'
import api from '../lib/api'
import { type TaskAction, parseAllTaskActions, stripActionBlocks } from '../lib/taskActions'
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

  const { data: interactions } = useQuery({
    queryKey: ['interactions', task.id],
    queryFn: () => api.get<TaskInteraction[]>(`/tasks/${task.id}/interactions`).then((r) => r.data),
  })

  // Seed chat from persisted interactions on first open (once)
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    const hasInteractions = interactions && interactions.length > 0
    const hasDeliverables = deliverables && deliverables.length > 0
    if (!hasInteractions && !hasDeliverables) return
    seededRef.current = true
    const interactionMsgs: ChatMsg[] = (interactions ?? []).map((m) => ({
      kind: m.role as 'user' | 'assistant',
      content: m.content,
    }))
    const deliverableMsgs: ChatMsg[] = (deliverables ?? []).map((d) => ({
      kind: 'deliverable' as const,
      content: d.content,
      actorName: assignedActor?.name ?? 'Agent',
    }))
    setChat([...interactionMsgs, ...deliverableMsgs])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactions, deliverables])

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
    mutationFn: ({ content, title }: { content: string; title?: string }) =>
      api.patch(`/tasks/${task.id}/description`, { content, title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const updateDetails = useMutation({
    mutationFn: (details: Record<string, string>) => api.patch(`/tasks/${task.id}/details`, { details }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const markReady = useMutation({
    mutationFn: (is_ready: boolean) => api.patch(`/tasks/${task.id}/ready`, { is_ready }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const assignedActor = actors.find((a) => {
    const a0 = Array.isArray(task.assignments)
      ? task.assignments[0]
      : (task.assignments as any)
    return a.id === a0?.actor_id
  })

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
      updateDescription.mutate({ content: action.content, title: action.title }, { onSuccess: markDone })
    } else if (action.intent === 'update_details') {
      updateDetails.mutate(action.details, { onSuccess: markDone })
    } else if (action.intent === 'mark_ready') {
      markReady.mutate(true, { onSuccess: markDone })
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
              {task.is_ready && (
                <span className="flex items-center gap-1 text-xs text-green-400 bg-green-900/30 border border-green-800/50 px-2 py-0.5 rounded-full">
                  <CheckCircle2 size={10} /> Ready
                </span>
              )}
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

          {/* Task Details (structured decisions) */}
          {task.task_details && Object.keys(task.task_details).length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-1.5">
                <ListChecks size={12} /> Decisions & Details
              </h3>
              <div className="space-y-1.5">
                {Object.entries(task.task_details).map(([key, value]) => (
                  <div key={key} className="flex gap-2 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-400 font-medium capitalize min-w-[100px] shrink-0">
                      {key.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs text-gray-200">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ready status + actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {!task.is_ready ? (
              <>
                <button
                  onClick={() => markReady.mutate(true)}
                  disabled={markReady.isPending}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-green-900/40 border border-green-700/50 text-green-400 hover:bg-green-800/50 transition-colors disabled:opacity-50"
                >
                  {markReady.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Mark Ready
                </button>
                <button
                  onClick={() => { markReady.mutate(true, { onSuccess: () => handleExecute() }) }}
                  disabled={markReady.isPending || isStreaming || !assignedActor}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-purple-900/40 border border-purple-700/50 text-purple-300 hover:bg-purple-800/50 transition-colors disabled:opacity-50"
                  title={!assignedActor ? 'Assign an AI actor first' : undefined}
                >
                  {(markReady.isPending || isStreaming) ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Mark Ready &amp; Start
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {assignedActor?.type === 'ai' && (
                  <button
                    onClick={() => { setChatOpen(true); handleExecute() }}
                    disabled={isStreaming}
                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-purple-700 hover:bg-purple-600 text-white transition-colors disabled:opacity-50"
                  >
                    {isStreaming ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    {isStreaming ? 'Running…' : 'Run Interactively'}
                  </button>
                )}
                <button
                  onClick={() => markReady.mutate(false)}
                  disabled={markReady.isPending}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 size={12} className="text-green-400" /> Ready · Unmark
                </button>
              </div>
            )}
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
              {task.status === 'todo' && 'Move to In Progress'}
              {task.status === 'in_progress' && 'Move to Review'}
              {task.status === 'review' && 'Move to Done'}
              {task.status === 'done' && 'Done ✓'}
              {task.status === 'rework' && 'Move to In Progress'}
            </button>
          </div>

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
                const actions = parseAllTaskActions(m.content)
                const prose = stripActionBlocks(m.content)

                // No structured actions — plain prose
                if (actions.length === 0) {
                  return (
                    <div key={i} className="bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap">
                      {m.content}
                    </div>
                  )
                }

                // One or more action cards + optional trailing questions/prose
                return (
                  <div key={i} className="space-y-2">
                    {actions.map((action, ai) => {
                      const cardKey = `${i}-${ai}`
                      const confirmed = confirmedIndices.has(i * 1000 + ai)
                      const markCardDone = () => setConfirmedIndices((p) => new Set([...p, i * 1000 + ai]))

                      if (action.intent === 'assign_actor') {
                        const target = actors.find(a => a.id === action.actor_id)
                        return (
                          <div key={cardKey} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                            <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide">Assign task</p>
                            <p className="text-sm text-white">
                              {target ? `${target.type === 'ai' ? '🤖' : '👤'} ${target.name}` : action.actor_name}
                              {target?.role && <span className="text-gray-400 text-xs ml-1">· {target.role}</span>}
                            </p>
                            <button onClick={() => { assign.mutate(action.actor_id, { onSuccess: markCardDone }) }} disabled={confirmed || assign.isPending}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                              style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(59,130,246,0.2)', color: '#93c5fd' }}>
                              {confirmed ? <><CheckCircle size={11} /> Assigned</> : assign.isPending ? <><Loader2 size={11} className="animate-spin" /> Assigning…</> : <><UserCheck size={11} /> Assign</>}
                            </button>
                          </div>
                        )
                      }
                      if (action.intent === 'update_status') {
                        return (
                          <div key={cardKey} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                            <p className="text-xs text-yellow-400 font-semibold uppercase tracking-wide">Update status</p>
                            <p className="text-sm text-white">{task.status} → <span className="font-semibold">{action.status.replace('_', ' ')}</span></p>
                            <button onClick={() => { updateStatus.mutate(action.status, { onSuccess: markCardDone }) }} disabled={confirmed || updateStatus.isPending}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                              style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(234,179,8,0.15)', color: '#facc15' }}>
                              {confirmed ? <><CheckCircle size={11} /> Done</> : updateStatus.isPending ? <><Loader2 size={11} className="animate-spin" /> Updating…</> : <><RefreshCw size={11} /> Apply</>}
                            </button>
                          </div>
                        )
                      }
                      if (action.intent === 'update_description') {
                        return (
                          <div key={cardKey} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                            <p className="text-xs text-teal-400 font-semibold uppercase tracking-wide">Update task documentation</p>
                            {action.title && (
                              <p className="text-xs font-semibold text-white bg-gray-950 rounded px-2 py-1">
                                📝 {action.title}
                              </p>
                            )}
                            <div className="text-xs text-gray-300 bg-gray-950 rounded-lg px-2 py-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
                              {action.content.slice(0, 300)}{action.content.length > 300 ? '…' : ''}
                            </div>
                            <button onClick={() => { updateDescription.mutate({ content: action.content, title: action.title }, { onSuccess: markCardDone }) }} disabled={confirmed || updateDescription.isPending}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                              style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(20,184,166,0.15)', color: '#2dd4bf' }}>
                              {confirmed ? <><CheckCircle size={11} /> Saved</> : updateDescription.isPending ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <><FileText size={11} /> Save title &amp; description</>}
                            </button>
                          </div>
                        )
                      }
                      if (action.intent === 'update_details') {
                        return (
                          <div key={cardKey} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                            <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1"><ListChecks size={11} /> Save decisions</p>
                            <div className="space-y-1">
                              {Object.entries(action.details).map(([k, v]) => (
                                <div key={k} className="flex gap-2 text-xs bg-gray-950 rounded px-2 py-1">
                                  <span className="text-gray-400 capitalize min-w-[90px] shrink-0">{k.replace(/_/g, ' ')}</span>
                                  <span className="text-gray-200">{v}</span>
                                </div>
                              ))}
                            </div>
                            <button onClick={() => { updateDetails.mutate(action.details, { onSuccess: markCardDone }) }} disabled={confirmed || updateDetails.isPending}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                              style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(59,130,246,0.15)', color: '#93c5fd' }}>
                              {confirmed ? <><CheckCircle size={11} /> Saved</> : updateDetails.isPending ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <><ListChecks size={11} /> Save to details</>}
                            </button>
                          </div>
                        )
                      }
                      if (action.intent === 'mark_ready') {
                        return (
                          <div key={cardKey} className="bg-gray-900 border border-green-800/50 rounded-xl p-3 space-y-2">
                            <p className="text-xs text-green-400 font-semibold uppercase tracking-wide flex items-center gap-1"><CheckCircle2 size={11} /> Mark as ready</p>
                            <p className="text-xs text-gray-300">{action.summary}</p>
                            <div className="flex gap-2 flex-wrap">
                              <button onClick={() => { markReady.mutate(true, { onSuccess: markCardDone }) }} disabled={confirmed || markReady.isPending}
                                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                                style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>
                                {confirmed ? <><CheckCircle size={11} /> Marked ready</> : markReady.isPending ? <><Loader2 size={11} className="animate-spin" /> Marking…</> : <><CheckCircle2 size={11} /> Mark Ready</>}
                              </button>
                              {!confirmed && assignedActor?.type === 'ai' && (
                                <button
                                  onClick={() => { markReady.mutate(true, { onSuccess: () => { markCardDone(); handleExecute() } }) }}
                                  disabled={markReady.isPending || isStreaming}
                                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                                  style={{ background: 'rgba(168,85,247,0.2)', color: '#c084fc' }}>
                                  <Play size={11} /> Ready &amp; Start
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      }
                      if (action.intent === 'execute_task') {
                        return (
                          <div key={cardKey} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                            <p className="text-xs text-purple-400 font-semibold uppercase tracking-wide">Execute task</p>
                            <p className="text-sm text-gray-300">Run AI execution for this task</p>
                            <button onClick={() => { handleExecute(); markCardDone() }} disabled={confirmed || isStreaming}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                              style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(168,85,247,0.2)', color: '#c084fc' }}>
                              {confirmed ? <><CheckCircle size={11} /> Started</> : isStreaming ? <><Loader2 size={11} className="animate-spin" /> Running…</> : <><Play size={11} /> Execute</>}
                            </button>
                          </div>
                        )
                      }
                      return null
                    })}
                    {prose && (
                      <div className="bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap">
                        {prose}
                      </div>
                    )}
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
