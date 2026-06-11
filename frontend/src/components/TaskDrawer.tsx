import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { X, Play, Loader2, Zap, Send, Bot, CheckCircle, UserCheck, MessageSquare, FileText, Sparkles, ChevronDown, CheckCircle2, ListChecks, Activity, GitPullRequest, Trash2, HelpCircle, Brain } from 'lucide-react'
import toast from 'react-hot-toast'
import type { Task, Actor, Deliverable, TaskInteraction, Assignment, Project } from '../types'
import api from '../lib/api'
import { parseAllTaskActions, stripActionBlocks } from '../lib/taskActions'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from '../lib/utils'
import { useConfirmation } from '../hooks/useConfirmation'
import { ConfirmationModal } from './ConfirmationModal'
import { AiCommandsModal } from './AiCommandsModal'
import { FileViewerModal } from './FileViewerModal'
import RepoGateModal from './RepoGateModal'
import { useAiLimitStore } from '../store/aiLimitStore'

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

// ─── File shape ──────────────────────────────────────────────────────────────
// The backend stores files as {path, url} (Supabase Storage links).
// The file viewer needs {path, content}.  We lazy-fetch content when the user
// opens the viewer so we never block the streaming output.
interface StoredFile {
  path: string
  url?: string      // present when stored as Storage object
  content?: string  // present when stored inline (legacy / small files)
}

/** Fetch file contents for all files that only have a url (no inline content). */
async function hydrateFiles(files: StoredFile[]): Promise<Array<{ path: string; content: string }>> {
  return Promise.all(
      files.map(async (f) => {
        if (f.content !== undefined && f.content !== '') {
          return { path: f.path, content: f.content }
        }
        if (f.url) {
          try {
            const res = await fetch(f.url)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const content = await res.text()
            return { path: f.path, content }
          } catch (err) {
            console.warn(`Failed to fetch file ${f.path}:`, err)
            return { path: f.path, content: `// Could not load file: ${f.path}\n// ${String(err)}` }
          }
        }
        return { path: f.path, content: '' }
      })
  )
}

/** Safely parse the files JSON blob from a deliverable, returning StoredFile[]. */
function parseDeliverableFiles(raw: unknown): StoredFile[] {
  if (!raw) return []
  try {
    const arr: unknown[] = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
    return arr.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const f = item as Record<string, unknown>
      if (typeof f.path !== 'string') return []
      return [{
        path: f.path,
        url: typeof f.url === 'string' ? f.url : undefined,
        content: typeof f.content === 'string' ? f.content : undefined,
      }]
    })
  } catch {
    return []
  }
}

async function fetchWithLimitCheck(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 402) {
    try {
      const body = await res.clone().json()
      const detail: string = body?.detail ?? ''
      const match = detail.match(/(\d+)\/(\d+)/)
      useAiLimitStore.getState().open(
          match ? { used: Number(match[1]), limit: Number(match[2]) } : {}
      )
    } catch {
      useAiLimitStore.getState().open()
    }
    throw new Error('AI prompt limit reached')
  }
  return res
}

async function readSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onPayload: (payload: string) => void
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const consumeLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      done = true
      return
    }
    onPayload(payload)
  }
  while (!done) {
    const { done: streamDone, value } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      consumeLine(line)
      if (done) break
    }
  }
  if (!done) {
    buffer += decoder.decode()
    if (buffer) {
      for (const line of buffer.split('\n')) {
        consumeLine(line)
        if (done) break
      }
    }
  }
  reader.cancel()
}

// Chat message types
type ChatMsg =
    | { kind: 'user'; content: string }
    | { kind: 'assistant'; content: string }
    | { kind: 'plan'; content: string }
    | { kind: 'deliverable'; content: string; actorName: string; files?: StoredFile[] }
    | { kind: 'memory'; titles: string[]; decisions: string[] }
    | { kind: 'thinking' }

interface Props {
  task: Task
  actors: Actor[]
  onClose: () => void
  githubConnected?: boolean
  githubRepo?: string | null
  githubTokenAvailable?: boolean
  githubRepos?: { full_name: string; private: boolean }[]
  onRepoSet?: (repo: string) => void
}

export default function TaskDrawer({ task, actors, onClose, githubConnected, githubRepo, githubTokenAvailable, githubRepos, onRepoSet }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)
  const { confirmation, confirm } = useConfirmation()
  const [showRepoGate, setShowRepoGate] = useState(false)

  const [chat, setChat] = useState<ChatMsg[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [promptInput, setPromptInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [confirmedIndices, setConfirmedIndices] = useState<Set<number>>(new Set())
  const [showTaskCommands, setShowTaskCommands] = useState(false)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)

  const pendingDetails = useMemo(() => {
    const lastAssistant = [...chat].reverse().find((m) => m.kind === 'assistant')
    if (!lastAssistant) return null
    const actions = parseAllTaskActions((lastAssistant as { kind: string; content: string }).content)
    const detailsAction = actions.find((a) => a.intent === 'update_details')
    if (!detailsAction?.details || Object.keys(detailsAction.details).length === 0) return null
    const existing = new Set(Object.keys(task.task_details ?? {}))
    const pending = Object.fromEntries(
        Object.entries(detailsAction.details as Record<string, string>).filter(([k, v]) => {
          const normalized = String(v ?? '').trim()
          const upper = normalized.toUpperCase()
          return !existing.has(k) && normalized.length > 0 && !['TBD', 'N/A', 'UNKNOWN', '?'].includes(upper)
        })
    )
    return Object.keys(pending).length > 0 ? pending : null
  }, [chat, task.task_details])

  // ─── File viewer state ─────────────────────────────────────────────────────
  const [fileViewerOpen, setFileViewerOpen] = useState(false)
  const [fileViewerFiles, setFileViewerFiles] = useState<Array<{ path: string; content: string }>>([])
  // Track which deliverable message is currently loading files (by chat index)
  const [loadingFilesIndex, setLoadingFilesIndex] = useState<number | null>(null)

  const scrollBottom = () => setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  const { data: deliverables } = useQuery({
    queryKey: ['deliverables', task.id],
    queryFn: () => api.get<Deliverable[]>(`/tasks/${task.id}/deliverables`).then((r) => r.data),
  })

  const { data: interactions } = useQuery({
    queryKey: ['interactions', task.id],
    queryFn: () => api.get<TaskInteraction[]>(`/tasks/${task.id}/interactions`).then((r) => r.data),
  })

  const assignedActor = actors.find((a) => {
    const a0 = Array.isArray(task.assignments)
        ? task.assignments[0]
        : (task.assignments as unknown as Assignment)
    return a.id === a0?.actor_id
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
     const deliverableMsgs: ChatMsg[] = (deliverables ?? []).map((d) => {
       // Use the safe parser — handles both {path,url} and {path,content} shapes
       const parsedFiles = parseDeliverableFiles(d.files)
       return {
         kind: 'deliverable' as const,
         content: d.content,
         actorName: assignedActor?.name ?? 'Agent',
         files: parsedFiles.length > 0 ? parsedFiles : undefined,
       }
     })
     // eslint-disable-next-line react-hooks/set-state-in-effect
     setChat([...interactionMsgs, ...deliverableMsgs])
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [interactions, deliverables])

  useEffect(() => {
    if (!isStreaming) return
    if (task.status === 'review' || task.status === 'done') {
      queueMicrotask(() => {
        setIsStreaming(false)
        qc.invalidateQueries({ queryKey: ['deliverables', task.id] })
        qc.invalidateQueries({ queryKey: ['project'] })
        setChat((prev) => {
          const withoutWaiting = prev.filter(
              (m) =>
                  !(
                      m.kind === 'plan' &&
                      (m as { kind: string; content: string }).content.includes('waiting for results')
                  )
          )
          return [
            ...withoutWaiting,
            {
              kind: 'plan',
              content: task.status === 'done' ? '✅ Agent finished — task marked done' : '✅ Agent finished — task moved to review',
            },
          ]
        })
        scrollBottom()
      })
    }
  }, [task.status, isStreaming, qc, task.id])


  const assign = useMutation({
    mutationFn: (actor_id: string) =>
        api.patch(`/tasks/${task.id}/assign`, { actor_id: actor_id || '' }),
    onSuccess: (response) => {
      const assignment = response.data
      qc.setQueryData(['project', task.project_id], (old: Project | undefined) => {
        if (!old) return old
        return {
          ...old,
          tasks: (old.tasks ?? []).map((t: Task) =>
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
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['project'] })
      const memory = (res.data as { memory?: { action?: string; title?: string } } | undefined)?.memory
      if (memory?.action === 'created') {
        toast.success(`Memory chunk created: ${memory.title}`)
      } else if (memory?.action === 'updated') {
        toast.success(`Memory chunk updated: ${memory.title}`)
      } else if (memory?.action === 'failed') {
        toast.error('Memory chunk save failed')
      }
    },
  })

  const markReady = useMutation({
    mutationFn: (is_ready: boolean) => api.patch(`/tasks/${task.id}/ready`, { is_ready }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const setAiReady = useMutation({
    mutationFn: (ai_ready: boolean) => api.patch(`/tasks/${task.id}/ai-ready`, { ai_ready }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })

  const deleteTask = useMutation({
    mutationFn: () => api.delete(`/tasks/${task.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project'] })
      onClose()
    },
  })

  const streamPrompt = async (msg: string) => {
    setIsStreaming(true)

    const historyForBackend = chat
        .filter((m) => m.kind === 'user' || m.kind === 'assistant')
        .map((m) => ({ role: m.kind as 'user' | 'assistant', content: (m as { kind: string; content: string }).content }))

    if (task.ai_ready) setAiReady.mutate(false)

    setChat((prev) => [...prev, { kind: 'user', content: msg }, { kind: 'thinking' }])
    scrollBottom()

    const ctrl = new AbortController()
    abortRef.current = ctrl
    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetchWithLimitCheck(`${baseUrl}/tasks/${task.id}/prompt/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg, history: historyForBackend }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error('Prompt stream unavailable')
      let assistantContent = ''
      await readSSE(res.body!.getReader(), (payload) => {
        try {
          const obj = JSON.parse(payload)
          if (obj.type === 'memory_event') {
            setChat((prev) => {
              const withoutThinking = prev.filter((m) => m.kind !== 'thinking')
              return [
                ...withoutThinking,
                { kind: 'memory', titles: obj.titles || [], decisions: obj.decisions || [] },
                { kind: 'thinking' },
              ]
            })
            return
          }
          if (typeof obj.content === 'string') assistantContent += obj.content
        } catch { /* malformed SSE chunk — skip */ }
      })
      setChat((prev) => [
        ...prev.filter((m) => m.kind !== 'thinking'),
        { kind: 'assistant', content: assistantContent },
      ])
      const actions = parseAllTaskActions(assistantContent)
      if (actions.some((a) => a.intent === 'mark_ready')) {
        setAiReady.mutate(true)
      }
    } catch {
      setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
    }

    setIsStreaming(false)
    scrollBottom()
  }

  const handleRefine = async () => {
    setChatOpen(true)
    await streamPrompt('Refine this task')
  }

  const handlePrompt = async () => {
    const msg = promptInput.trim()
    if (!msg || isStreaming) return
    setPromptInput('')
    await streamPrompt(msg)
  }

  const handleExecute = async () => {
    if (isStreaming) return

    // Gate: no project repo selected (or not connected) -> show repo picker before execute
    const hasProjectRepo = !!githubRepo && githubRepo.trim().length > 0
    if (!githubConnected || !hasProjectRepo) {
      setShowRepoGate(true)
      return
    }

    await doExecute()
  }

  const doExecute = async () => {
    setShowRepoGate(false)
    setIsStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const actorName = assignedActor?.name ?? 'Agent'

    setChat((prev) => [...prev, { kind: 'thinking' }])
    scrollBottom()

    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'

    try {
      const res = await fetchWithLimitCheck(`${baseUrl}/tasks/${task.id}/execute/stream`, { signal: ctrl.signal })
      if (!res.ok || !res.body) throw new Error('Execute stream unavailable')
      let planShown = false
      let deliverableContent = ''
      let streamedFiles: StoredFile[] = []

      await readSSE(res.body!.getReader(), (payload) => {
        try {
          const evt = JSON.parse(payload)
          if (evt.type === 'error') {
            toast.error(evt.message || 'AI execution failed')
            setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
            return
          }
          if (evt.type === 'plan') {
            setChat((prev) => [
              ...prev.filter((m) => m.kind !== 'thinking'),
              { kind: 'plan', content: evt.content },
            ])
            planShown = true
            scrollBottom()
          } else if (evt.type === 'content') {
            deliverableContent += evt.content
          } else if (evt.type === 'files' && Array.isArray(evt.files)) {
            streamedFiles = parseDeliverableFiles(evt.files)
          } else if (evt.content) {
            deliverableContent += evt.content
          }
        } catch { /* malformed SSE chunk — skip */ }
      })


      const isDispatchMessage = (
          deliverableContent.startsWith('Docker agent dispatched:') ||
          deliverableContent.startsWith('Dispatching to external') ||
          (deliverableContent.includes('"dispatched"') && deliverableContent.includes('"task_id"'))
      )

      if (isDispatchMessage) {
        setChat((prev) => [
          ...prev.filter((m) => m.kind !== 'thinking'),
          {
            kind: 'plan',
            content: `⏳ Agent dispatched — waiting for results…`,
          },
        ])
        scrollBottom()
        setIsStreaming(false)
        qc.invalidateQueries({ queryKey: ['deliverables', task.id] })
        qc.invalidateQueries({ queryKey: ['project'] })
        return
      }

      if (deliverableContent) {
        const filesMarker = deliverableContent.indexOf('###FILES###')
        let narrativeContent = deliverableContent
        if (filesMarker !== -1 && streamedFiles.length === 0) {
          try {
            const afterMarker = deliverableContent.slice(filesMarker + '###FILES###'.length).trim()
            const arrStart = afterMarker.indexOf('[')
            if (arrStart !== -1) {
              streamedFiles = parseDeliverableFiles(JSON.parse(afterMarker.slice(arrStart)))
            }
          } catch { /* ignore malformed FILES block */ }
          narrativeContent = deliverableContent.slice(0, filesMarker).trim()
        }

        setChat((prev) => [
          ...prev.filter((m) => m.kind !== 'thinking'),
          ...(planShown ? [] : []),
          {
            kind: 'deliverable',
            content: narrativeContent,
            actorName,
            files: streamedFiles.length > 0 ? streamedFiles : undefined,
          },
        ])
      } else {
        setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Execution failed'
      toast.error(message)
      setChat((prev) => prev.filter((m) => m.kind !== 'thinking'))
    }

    setIsStreaming(false)
    qc.invalidateQueries({ queryKey: ['deliverables', task.id] })
    qc.invalidateQueries({ queryKey: ['project'] })
    scrollBottom()
  }

  /** Open the file viewer: fetch any URL-only files first, then show modal. */
  const handleViewFiles = async (files: StoredFile[], msgIndex: number) => {
    setLoadingFilesIndex(msgIndex)
    try {
      const hydrated = await hydrateFiles(files)
      setFileViewerFiles(hydrated)
      setFileViewerOpen(true)
    } catch (err) {
      toast.error('Could not load file contents')
      console.error(err)
    } finally {
      setLoadingFilesIndex(null)
    }
  }

  return (
      <div className="fixed inset-0 z-50 flex">
        {/* Backdrop */}
        <div className="flex-1 bg-black/50" onClick={onClose} />
        {/* Drawer */}
        <div className="w-full max-w-3xl bg-gray-950 border-l border-gray-800 flex flex-col overflow-hidden">
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
            <div className="flex items-center gap-2 mt-1">
              <button
                  onClick={() => navigate(`/projects/${task.project_id}/activity?task=${task.id}`)}
                  className="text-gray-500 hover:text-white transition-colors"
                  title="Task activity"
              >
                <Activity size={16} />
              </button>
              <button
                  onClick={async () => {
                    const confirmed = await confirm({
                      title: 'Delete Task',
                      message: 'Delete this task? This cannot be undone.',
                      confirmText: 'Delete',
                      cancelText: 'Cancel',
                      isDangerous: true,
                    })
                    if (confirmed) deleteTask.mutate()
                  }}
                  disabled={deleteTask.isPending}
                  className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                  title="Delete task"
              >
                {deleteTask.isPending ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              </button>
              <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            {/* GitHub PR / branch details */}
            {task.github_pr_url && (() => {
              const branchName = `ownflow/${task.id.slice(0, 8)}`
              const safeTitle = task.title.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().replace(/ /g, '_').slice(0, 50)
              const filePath = `.ownflow/tasks/${task.id.slice(0, 8)}_${safeTitle}.md`
              const prState = task.github_pr_state
              const stateBadge =
                  prState === 'merged'
                      ? { label: 'Merged', cls: 'bg-purple-900/40 text-purple-300 border border-purple-700/50' }
                      : prState === 'closed'
                          ? { label: 'Closed', cls: 'bg-gray-800 text-gray-400 border border-gray-700' }
                          : { label: 'Open', cls: 'bg-green-900/40 text-green-400 border border-green-800/50' }
              return (
                  <div className="bg-gray-900 border border-purple-800/40 rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-medium text-gray-400 uppercase flex items-center gap-1.5">
                      <GitPullRequest size={12} className="text-purple-400" /> GitHub Changes
                    </h3>
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 w-16 shrink-0">Branch</span>
                        <span className="font-mono text-purple-300 bg-purple-900/30 px-2 py-0.5 rounded">{branchName}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-gray-500 w-16 shrink-0 pt-0.5">File</span>
                        <span className="font-mono text-gray-300 bg-gray-800 px-2 py-0.5 rounded break-all">{filePath}</span>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <span className="text-gray-500 w-16 shrink-0">PR</span>
                        <a
                            href={task.github_pr_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-purple-400 hover:text-purple-300 underline underline-offset-2 break-all"
                        >
                          <GitPullRequest size={12} />
                          View pull request ↗
                        </a>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${stateBadge.cls}`}>
                      {stateBadge.label}
                    </span>
                      </div>
                    </div>
                  </div>
              )
            })()}

            {/* Description */}
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Description</h3>
              <div className="prose prose-invert prose-sm max-w-none text-gray-300 [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-sm [&>h1]:font-semibold [&>h2]:font-semibold [&>h3]:font-medium [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4 [&>li]:my-0.5 [&>p]:leading-relaxed [&>strong]:text-white [&_strong]:text-white">
                <ReactMarkdown>{task.description ?? ''}</ReactMarkdown>
              </div>
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

            {/* Pending decisions from AI */}
            {pendingDetails && assignedActor?.type === 'ai' && (
                <div className="bg-blue-950/40 border border-blue-700/50 rounded-xl p-3 space-y-2">
                  <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1.5">
                    <ListChecks size={11} /> Unsaved decisions from AI
                  </p>
                  <div className="space-y-1">
                    {Object.entries(pendingDetails).map(([k, v]) => (
                        <div key={k} className="flex gap-2 text-xs bg-gray-950 rounded px-2 py-1">
                          <span className="text-gray-400 capitalize min-w-[90px] shrink-0">{k.replace(/_/g, ' ')}</span>
                          <span className="text-gray-200">{v}</span>
                        </div>
                    ))}
                  </div>
                  <button
                      onClick={() => updateDetails.mutate(pendingDetails)}
                      disabled={updateDetails.isPending}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium bg-blue-900/30 border border-blue-700/50 text-blue-300 hover:bg-blue-800/40 transition-colors disabled:opacity-50"
                  >
                    {updateDetails.isPending ? <Loader2 size={11} className="animate-spin" /> : <ListChecks size={11} />}
                    Save to details
                  </button>
                </div>
            )}

            {/* Ready status + actions */}
            <div className="flex items-center gap-2 flex-wrap">
              {assignedActor?.type === 'ai' ? (
                  <>
                    {task.status === 'review' && task.agent_dispatched_at ? (
                        <span className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-900/30 border border-amber-700/50 px-2.5 py-1 rounded-full">
                    <CheckCircle2 size={11} /> AI Executed — awaiting validation
                  </span>
                    ) : !task.is_ready ? (
                        <>
                          {task.ai_ready ? (
                              <>
                        <span className="flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-900/30 border border-yellow-700/50 px-2.5 py-1 rounded-full">
                          <Sparkles size={11} /> AI Ready — awaiting your approval
                        </span>
                                <button
                                    onClick={() => markReady.mutate(true)}
                                    disabled={markReady.isPending}
                                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-green-900/40 border border-green-700/50 text-green-400 hover:bg-green-800/50 transition-colors disabled:opacity-50"
                                >
                                  {markReady.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                                  Approve
                                </button>
                                <button
                                    onClick={() => markReady.mutate(true, { onSuccess: () => handleExecute() })}
                                    disabled={markReady.isPending || isStreaming}
                                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-purple-900/40 border border-purple-700/50 text-purple-300 hover:bg-purple-800/50 transition-colors disabled:opacity-50"
                                >
                                  {(markReady.isPending || isStreaming) ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                                  Approve &amp; Start
                                </button>
                                <button
                                    onClick={() => setAiReady.mutate(false)}
                                    disabled={setAiReady.isPending}
                                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                                >
                                  Reset
                                </button>
                              </>
                          ) : (
                              <span className="text-xs text-gray-500 italic">AI is collecting decisions before this task can be executed</span>
                          )}
                        </>
                    ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                              onClick={() => { setChatOpen(true); handleExecute() }}
                              disabled={isStreaming}
                              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-purple-700 hover:bg-purple-600 text-white transition-colors disabled:opacity-50"
                          >
                            {isStreaming ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                            {isStreaming ? 'Running…' : 'Run'}
                          </button>
                          <button
                              onClick={() => markReady.mutate(false)}
                              disabled={markReady.isPending}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                          >
                            <CheckCircle2 size={12} className="text-green-400" /> Approved · Revoke
                          </button>
                        </div>
                    )}
                  </>
              ) : (
                  !task.is_ready ? (
                      <button
                          onClick={() => markReady.mutate(true)}
                          disabled={markReady.isPending}
                          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-green-900/40 border border-green-700/50 text-green-400 hover:bg-green-800/50 transition-colors disabled:opacity-50"
                      >
                        {markReady.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        Mark Ready
                      </button>
                  ) : (
                      <button
                          onClick={() => markReady.mutate(false)}
                          disabled={markReady.isPending}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                      >
                        <CheckCircle2 size={12} className="text-green-400" /> Ready · Unmark
                      </button>
                  )
              )}
            </div>

            {/* Status + Assignment */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Status</h3>
                <div className="flex gap-2">
                  <select
                      value={task.status}
                      onChange={(e) => updateStatus.mutate(e.target.value)}
                      className="flex-1 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s.replace('_', ' ')}
                        </option>
                    ))}
                  </select>
                </div>
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
            <div className="flex items-center gap-2 flex-wrap">
              {!task.ai_ready && assignedActor && !task.agent_dispatched_at && (
                  <button
                      onClick={handleRefine}
                      disabled={isStreaming}
                      className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg font-medium bg-blue-900/40 border border-blue-700/50 text-blue-400 hover:bg-blue-800/50 transition-colors disabled:opacity-50"
                      title="Refine this task"
                  >
                    {isStreaming ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />}
                    Refine
                  </button>
              )}
              {task.status === 'review' && task.agent_dispatched_at && (
                  <>
                    <button
                        onClick={() => { setChatOpen(true); streamPrompt('Please validate the execution of this task. Review the deliverables and tell me: was the task implemented correctly? Are there any issues or gaps that need rework?') }}
                        disabled={isStreaming}
                        className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg font-medium bg-amber-900/40 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 transition-colors disabled:opacity-50"
                        title="Ask AI to validate execution results"
                    >
                      {isStreaming ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                      Validate results
                    </button>
                    <button
                        onClick={() => { updateStatus.mutate('in_progress', { onSuccess: () => handleExecute() }) }}
                        disabled={isStreaming || updateStatus.isPending}
                        className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg font-medium bg-orange-900/40 border border-orange-700/50 text-orange-400 hover:bg-orange-800/50 transition-colors disabled:opacity-50"
                        title="Restart task execution"
                    >
                      {(isStreaming || updateStatus.isPending) ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      Restart Execution
                    </button>
                  </>
              )}
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
          <div className="border-t border-purple-900/60 bg-gray-950 flex flex-col" style={chatOpen ? { minHeight: '280px', maxHeight: '55%' } : {}}>
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-2.5 shrink-0 select-none bg-purple-950/40 border-b border-purple-900/40">
              <Bot size={14} className="text-purple-400" />
              <div className="flex flex-col min-w-0">
              <span className="text-xs text-purple-300 font-semibold tracking-wide leading-none">
                {assignedActor ? assignedActor.name : 'AI Copilot'}
                {assignedActor && (
                    <span className="text-purple-600 font-normal"> · {assignedActor.role || assignedActor.model || assignedActor.type}</span>
                )}
              </span>
                <span className="text-xs text-gray-500 truncate leading-tight mt-0.5">{task.title}</span>
              </div>
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
                  title={chatOpen ? 'Collapse Copilot' : 'Open Copilot'}
              >
                <ChevronDown size={13} className={`transition-transform ${chatOpen ? '' : '-rotate-90'}`} />
              </button>
            </div>

            {/* Message log */}
            {chatOpen && (
                <>
                  <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0">
                    {!assignedActor ? (
                        <div className="flex flex-col items-center justify-center h-full py-8 gap-3 text-center">
                          <Bot size={28} className="text-gray-700" />
                          <p className="text-sm text-gray-400 font-medium">No AI actor assigned</p>
                          <p className="text-xs text-gray-600 max-w-[220px]">
                            Assign an AI actor to this task first using the <span className="text-gray-400">Assigned to</span> dropdown above.
                          </p>
                        </div>
                    ) : chat.length === 0 ? (
                        <p className="text-xs text-gray-700 py-2">
                          Ask {assignedActor.name} anything about this task, or type &quot;execute&quot; to run it.
                        </p>
                    ) : null}

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

                      if (m.kind === 'memory') {
                        const hasAny = m.titles.length > 0 || m.decisions.length > 0
                        return (
                            <div key={i} className="bg-blue-950/40 border border-blue-800/40 rounded-xl px-3 py-2">
                              <div className="flex items-center gap-1.5 mb-1">
                                <Brain size={11} className="text-blue-400" />
                                <span className="text-xs text-blue-400 font-medium uppercase tracking-wide">
                            Memory consulted
                          </span>
                                <span className="text-[10px] text-gray-500 ml-auto">
                            {m.titles.length} chunk{m.titles.length === 1 ? '' : 's'}
                                  {m.decisions.length > 0 ? `, ${m.decisions.length} decision${m.decisions.length === 1 ? '' : 's'}` : ''}
                          </span>
                              </div>
                              {hasAny ? (
                                  <ul className="text-[11px] text-gray-400 space-y-0.5">
                                    {m.titles.map((t, j) => (
                                        <li key={`t-${j}`} className="truncate">• {t}</li>
                                    ))}
                                    {m.decisions.map((d, j) => (
                                        <li key={`d-${j}`} className="truncate">◆ {d}</li>
                                    ))}
                                  </ul>
                              ) : (
                                  <p className="text-[11px] text-gray-500 italic">No prior memory found for this question.</p>
                              )}
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
                        // Strip legacy ###FILES### block from display text
                        const filesMarker = m.content.indexOf('###FILES###')
                        const narrativeText = filesMarker !== -1 ? m.content.slice(0, filesMarker).trim() : m.content
                        const files = m.files ?? []
                        const isLoading = loadingFilesIndex === i

                        return (
                            <div key={i} className="bg-gray-900 border border-green-800/40 rounded-xl px-3 py-2">
                              <div className="flex items-center gap-1.5 mb-2">
                                <FileText size={11} className="text-green-400" />
                                <span className="text-xs text-green-400 font-medium uppercase tracking-wide">
                            Result · {m.actorName}
                          </span>
                              </div>
                              {narrativeText && (
                                  <div className="text-xs text-gray-300 max-h-96 overflow-y-auto pr-1 prose prose-invert prose-xs max-w-none [&>h1]:text-sm [&>h2]:text-xs [&>h3]:text-xs [&>h1]:font-semibold [&>h2]:font-semibold [&>h3]:font-medium [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4 [&>li]:my-0.5 [&>p]:leading-relaxed [&_strong]:text-white [&>pre]:bg-gray-950 [&>pre]:rounded [&>pre]:p-2 [&>code]:text-green-300">
                                    <ReactMarkdown>{narrativeText}</ReactMarkdown>
                                  </div>
                              )}
                               {files.length > 0 && (
                                   <div className="mt-3 space-y-2">
                                     {/* File name chips — clickable */}
                                     <div className="flex flex-wrap gap-1.5">
                                       {files.map((f, fi) => (
                                           <button
                                               key={fi}
                                               onClick={() => handleViewFiles(files, i)}
                                               disabled={isLoading}
                                               className="flex items-center gap-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-green-600 text-gray-300 hover:text-green-300 px-2 py-0.5 rounded-md font-mono transition-colors disabled:opacity-50 cursor-pointer"
                                               title="Click to open file viewer"
                                           >
                                               <FileText size={10} className="text-green-400 shrink-0" />
                                               {f.path}
                                           </button>
                                       ))}
                                     </div>
                                     {/* View Files button — lazy-fetches content on click */}
                                     <button
                                         onClick={() => handleViewFiles(files, i)}
                                         disabled={isLoading}
                                         className="w-full text-xs px-3 py-1.5 rounded-lg font-medium bg-green-900/30 hover:bg-green-800/40 text-green-300 border border-green-700/50 transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
                                     >
                                       {isLoading
                                           ? <><Loader2 size={11} className="animate-spin" /> Loading files…</>
                                           : <>👁️ View Files ({files.length})</>}
                                     </button>
                                   </div>
                               )}
                            </div>
                        )
                      }

                      if (m.kind === 'assistant') {
                        const actions = parseAllTaskActions(m.content)
                        const prose = stripActionBlocks(m.content)

                        if (actions.length === 0) {
                          return (
                              <div key={i} className="bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-300 prose prose-invert prose-sm max-w-none [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-sm [&>h1]:font-semibold [&>h2]:font-semibold [&>h3]:font-medium [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4 [&>li]:my-0.5 [&_strong]:text-white">
                                <ReactMarkdown>{m.content}</ReactMarkdown>
                              </div>
                          )
                        }

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
                                          {confirmed ? <><CheckCircle size={11} /> Done</> : updateStatus.isPending ? <><Loader2 size={11} className="animate-spin" /> Updating…</> : <><Zap size={11} /> Apply</>}
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
                                  if (!action.details || Object.keys(action.details).length === 0) return null
                                  const existingKeys = new Set(Object.keys(task.task_details ?? {}))
                                  const newDetails = Object.fromEntries(
                                      Object.entries(action.details as Record<string, string>).filter(([k]) => !existingKeys.has(k))
                                  )
                                  if (Object.keys(newDetails).length === 0) return null
                                  return (
                                      <div key={cardKey} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
                                        <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1"><ListChecks size={11} /> Save decisions</p>
                                        <div className="space-y-1">
                                          {Object.entries(newDetails).map(([k, v]) => (
                                              <div key={k} className="flex gap-2 text-xs bg-gray-950 rounded px-2 py-1">
                                                <span className="text-gray-400 capitalize min-w-[90px] shrink-0">{k.replace(/_/g, ' ')}</span>
                                                <span className="text-gray-200">{v}</span>
                                              </div>
                                          ))}
                                        </div>
                                        <button onClick={() => { updateDetails.mutate(newDetails, { onSuccess: markCardDone }) }} disabled={confirmed || updateDetails.isPending}
                                                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                                                style={confirmed ? { background: 'rgba(34,197,94,0.15)', color: '#4ade80' } : { background: 'rgba(59,130,246,0.15)', color: '#93c5fd' }}>
                                          {confirmed ? <><CheckCircle size={11} /> Saved</> : updateDetails.isPending ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <><ListChecks size={11} /> Save to details</>}
                                        </button>
                                      </div>
                                  )
                                }
                                if (action.intent === 'mark_ready') {
                                  return (
                                      <div key={cardKey} className="bg-gray-900 border border-yellow-800/50 rounded-xl p-3 space-y-1.5">
                                        <p className="text-xs text-yellow-400 font-semibold uppercase tracking-wide flex items-center gap-1"><Sparkles size={11} /> AI: task is ready to implement</p>
                                        <p className="text-xs text-gray-300">{action.summary}</p>
                                        <span className="inline-flex items-center gap-1 text-xs text-green-400">
                                  <CheckCircle size={11} /> Marked AI ready automatically
                                </span>
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
                                  <div className="bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-300 prose prose-invert prose-sm max-w-none [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-sm [&>h1]:font-semibold [&>h2]:font-semibold [&>h3]:font-medium [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4 [&>li]:my-0.5 [&_strong]:text-white">
                                    <ReactMarkdown>{prose}</ReactMarkdown>
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
                    <button
                        onClick={() => setShowTaskCommands(true)}
                        className="text-gray-500 hover:text-purple-400 transition-colors shrink-0 pb-2"
                        title="Show available commands"
                    >
                      <HelpCircle size={15} />
                    </button>
                    <textarea
                        rows={1}
                        value={promptInput}
                        onChange={(e) => setPromptInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePrompt() } }}
                        placeholder={assignedActor ? `Ask ${assignedActor.name}…` : 'Assign an AI actor first…'}
                        disabled={!assignedActor}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                    <button
                        onClick={handlePrompt}
                        disabled={!promptInput.trim() || isStreaming || !assignedActor}
                        className="p-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg transition-colors shrink-0"
                    >
                      {isStreaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  </div>
                </>
            )}
          </div>
        </div>

        <ConfirmationModal
            confirmation={confirmation}
            onConfirm={() => confirmation?.onConfirm()}
            onCancel={() => confirmation?.onCancel()}
        />

        {/* Pre-execute gate: repo not connected */}
        {showRepoGate && (
            <RepoGateModal
                githubTokenAvailable={githubTokenAvailable}
                githubRepos={githubRepos}
                onRepoSet={onRepoSet}
                onExecuteWithout={() => doExecute()}
                onCancel={() => setShowRepoGate(false)}
            />
        )}

        {showTaskCommands && (
            <AiCommandsModal
                context="task"
                onClose={() => setShowTaskCommands(false)}
                onCommandClick={(example) => { setPromptInput(example); setChatOpen(true) }}
            />
        )}

        <FileViewerModal
            key={String(fileViewerOpen)}
            files={fileViewerFiles}
            isOpen={fileViewerOpen}
            onClose={() => setFileViewerOpen(false)}
            taskTitle={task.title}
        />
      </div>
  )
}
