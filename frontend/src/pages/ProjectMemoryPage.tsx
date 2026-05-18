import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ChevronLeft,
  Brain,
  BookOpen,
  GitMerge,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Check,
  X,
} from 'lucide-react'
import api from '../lib/api'
import { formatDistanceToNow } from 'date-fns'
import type { MemoryChunk, Decision, MemorySourceType, DecisionStatus } from '../types'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATIC_TYPES: { value: MemorySourceType; label: string }[] = [
  { value: 'product', label: 'Product' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'coding-standards', label: 'Coding Standards' },
  { value: 'business-rules', label: 'Business Rules' },
]

const GITHUB_TYPES: { value: MemorySourceType; label: string }[] = [
  { value: 'pull_request', label: 'Pull Requests' },
  { value: 'code_file', label: 'Code Files' },
  { value: 'commit', label: 'Commits' },
]

const IMPORTANCE_COLORS: Record<number, string> = {
  10: 'bg-red-500',
  9: 'bg-red-500',
  8: 'bg-orange-500',
  7: 'bg-orange-400',
  6: 'bg-yellow-500',
  5: 'bg-yellow-400',
  4: 'bg-green-500',
  3: 'bg-green-400',
  2: 'bg-gray-500',
  1: 'bg-gray-500',
}

const STATUS_STYLES: Record<DecisionStatus, string> = {
  active: 'bg-green-900/50 text-green-300 border-green-700/50',
  draft: 'bg-gray-800 text-gray-300 border-gray-600',
  superseded: 'bg-yellow-900/40 text-yellow-400 border-yellow-700/40',
  rejected: 'bg-red-900/40 text-red-400 border-red-700/40',
}

type Tab = 'memory' | 'decisions' | 'github'

// ── Sub-components ────────────────────────────────────────────────────────────

function ImportanceDot({ importance }: { importance: number }) {
  const color = IMPORTANCE_COLORS[importance] ?? 'bg-gray-500'
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white ${color}`}
      title={`Importance: ${importance}`}
    >
      {importance}
    </span>
  )
}

// ── Chunk Form ────────────────────────────────────────────────────────────────

interface ChunkFormData {
  source_type: MemorySourceType
  title: string
  content: string
  summary: string
  importance: number
  tags: string
}

const DEFAULT_CHUNK_FORM: ChunkFormData = {
  source_type: 'product',
  title: '',
  content: '',
  summary: '',
  importance: 5,
  tags: '',
}

interface ChunkFormProps {
  initial?: Partial<ChunkFormData>
  onSubmit: (data: ChunkFormData) => void
  onCancel: () => void
  isPending: boolean
  submitLabel: string
}

function ChunkForm({ initial, onSubmit, onCancel, isPending, submitLabel }: ChunkFormProps) {
  const [form, setForm] = useState<ChunkFormData>({ ...DEFAULT_CHUNK_FORM, ...initial })

  function set(field: keyof ChunkFormData, value: string | number) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Type</label>
          <select
            value={form.source_type}
            onChange={(e) => set('source_type', e.target.value as MemorySourceType)}
            className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
          >
            {[...STATIC_TYPES, ...GITHUB_TYPES].map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Importance (1–10)</label>
          <input
            type="number"
            min={1}
            max={10}
            value={form.importance}
            onChange={(e) => set('importance', Math.min(10, Math.max(1, Number(e.target.value))))}
            className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Title</label>
        <input
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="e.g. Tech Stack Overview"
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Content</label>
        <textarea
          value={form.content}
          onChange={(e) => set('content', e.target.value)}
          rows={5}
          placeholder="Full content that the AI can read…"
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Summary <span className="text-gray-600">(optional — shown in context packs)</span></label>
        <textarea
          value={form.summary}
          onChange={(e) => set('summary', e.target.value)}
          rows={2}
          placeholder="Short summary for context packs…"
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Tags <span className="text-gray-600">(comma-separated)</span></label>
        <input
          value={form.tags}
          onChange={(e) => set('tags', e.target.value)}
          placeholder="e.g. backend, api, auth"
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(form)}
          disabled={isPending || !form.title.trim() || !form.content.trim()}
          className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm text-white transition-colors disabled:opacity-40"
        >
          {isPending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  )
}

// ── Decision Form ─────────────────────────────────────────────────────────────

interface DecisionFormData {
  title: string
  status: DecisionStatus
  context: string
  decision: string
  reason: string
  consequences: string
}

const DEFAULT_DECISION_FORM: DecisionFormData = {
  title: '',
  status: 'active',
  context: '',
  decision: '',
  reason: '',
  consequences: '',
}

interface DecisionFormProps {
  initial?: Partial<DecisionFormData>
  onSubmit: (data: DecisionFormData) => void
  onCancel: () => void
  isPending: boolean
  submitLabel: string
}

function DecisionForm({ initial, onSubmit, onCancel, isPending, submitLabel }: DecisionFormProps) {
  const [form, setForm] = useState<DecisionFormData>({ ...DEFAULT_DECISION_FORM, ...initial })

  function set(field: keyof DecisionFormData, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Title</label>
          <input
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="e.g. Use PostgreSQL as main DB"
            className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Status</label>
          <select
            value={form.status}
            onChange={(e) => set('status', e.target.value as DecisionStatus)}
            className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="superseded">Superseded</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Context <span className="text-gray-600">(why was this decision needed?)</span></label>
        <textarea
          value={form.context}
          onChange={(e) => set('context', e.target.value)}
          rows={2}
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Decision <span className="text-red-400">*</span></label>
        <textarea
          value={form.decision}
          onChange={(e) => set('decision', e.target.value)}
          rows={3}
          placeholder="What was decided…"
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Reason</label>
        <textarea
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
          rows={2}
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Consequences</label>
        <textarea
          value={form.consequences}
          onChange={(e) => set('consequences', e.target.value)}
          rows={2}
          className="w-full px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(form)}
          disabled={isPending || !form.title.trim() || !form.decision.trim()}
          className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm text-white transition-colors disabled:opacity-40"
        >
          {isPending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  )
}

// ── Memory Tab ────────────────────────────────────────────────────────────────

function MemoryTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [addingType, setAddingType] = useState<MemorySourceType | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filterType, setFilterType] = useState<MemorySourceType | 'all'>('all')

  const { data: chunks = [], isLoading } = useQuery<MemoryChunk[]>({
    queryKey: ['memory-chunks', projectId],
    queryFn: () => api.get(`/projects/${projectId}/memory`).then((r) => r.data),
  })

  const createMutation = useMutation({
    mutationFn: (body: object) => api.post(`/projects/${projectId}/memory`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory-chunks', projectId] })
      setAddingType(null)
      toast.success('Memory chunk created')
    },
    onError: () => toast.error('Failed to create memory chunk'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api.patch(`/projects/${projectId}/memory/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory-chunks', projectId] })
      setEditingId(null)
      toast.success('Memory chunk updated')
    },
    onError: () => toast.error('Failed to update memory chunk'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/memory/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory-chunks', projectId] })
      toast.success('Memory chunk deleted')
    },
    onError: () => toast.error('Failed to delete memory chunk'),
  })

  function handleCreate(data: ChunkFormData) {
    createMutation.mutate({
      source_type: data.source_type,
      title: data.title,
      content: data.content,
      summary: data.summary || null,
      importance: data.importance,
      tags: data.tags.split(',').map((t) => t.trim()).filter(Boolean),
    })
  }

  function handleUpdate(id: string, data: ChunkFormData) {
    updateMutation.mutate({
      id,
      body: {
        title: data.title,
        content: data.content,
        summary: data.summary || null,
        importance: data.importance,
        tags: data.tags.split(',').map((t) => t.trim()).filter(Boolean),
      },
    })
  }

  const allTypes = [...STATIC_TYPES, ...GITHUB_TYPES]
  const filtered =
    filterType === 'all' ? chunks : chunks.filter((c) => c.source_type === filterType)

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as MemorySourceType | 'all')}
          className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
        >
          <option value="all">All types</option>
          {allTypes.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <div className="ml-auto">
          <button
            onClick={() => setAddingType('product')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm text-white transition-colors"
          >
            <Plus size={13} />
            Add chunk
          </button>
        </div>
      </div>

      {/* Add form */}
      {addingType && (
        <ChunkForm
          initial={{ source_type: addingType }}
          onSubmit={handleCreate}
          onCancel={() => setAddingType(null)}
          isPending={createMutation.isPending}
          submitLabel="Create"
        />
      )}

      {isLoading && (
        <div className="text-center py-10 text-sm text-gray-500">Loading…</div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-10 text-sm text-gray-500">
          No memory chunks yet.{' '}
          <button
            className="text-purple-400 hover:underline"
            onClick={() => setAddingType('product')}
          >
            Add the first one
          </button>
        </div>
      )}

      {/* Chunk list */}
      <div className="space-y-2">
        {filtered.map((chunk) => {
          const isExpanded = expandedId === chunk.id
          const isEditing = editingId === chunk.id
          const typeLabel = allTypes.find((t) => t.value === chunk.source_type)?.label ?? chunk.source_type
          return (
            <div
              key={chunk.id}
              className="border border-gray-800 rounded-xl overflow-hidden bg-gray-900/50"
            >
              {isEditing ? (
                <div className="p-3">
                  <ChunkForm
                    initial={{
                      source_type: chunk.source_type,
                      title: chunk.title,
                      content: chunk.content,
                      summary: chunk.summary ?? '',
                      importance: chunk.importance,
                      tags: chunk.tags.join(', '),
                    }}
                    onSubmit={(data) => handleUpdate(chunk.id, data)}
                    onCancel={() => setEditingId(null)}
                    isPending={updateMutation.isPending}
                    submitLabel="Save"
                  />
                </div>
              ) : (
                <>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <ImportanceDot importance={chunk.importance} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded">
                          {typeLabel}
                        </span>
                        {chunk.tags.map((tag) => (
                          <span key={tag} className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                        <span className="ml-auto text-xs text-gray-600">
                          {formatDistanceToNow(new Date(chunk.updated_at), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-white mt-1">{chunk.title}</p>
                      {chunk.summary && (
                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{chunk.summary}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : chunk.id)}
                        className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button
                        onClick={() => setEditingId(chunk.id)}
                        className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(chunk.id)}
                        disabled={deleteMutation.isPending}
                        className="p-1.5 rounded-lg hover:bg-red-900/50 text-gray-400 hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-0 border-t border-gray-800">
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
                        {chunk.content}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Decisions Tab ─────────────────────────────────────────────────────────────

function DecisionsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<DecisionStatus | 'all'>('all')

  const { data: decisions = [], isLoading } = useQuery<Decision[]>({
    queryKey: ['decisions', projectId],
    queryFn: () => api.get(`/projects/${projectId}/decisions`).then((r) => r.data),
  })

  const createMutation = useMutation({
    mutationFn: (body: object) => api.post(`/projects/${projectId}/decisions`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['decisions', projectId] })
      setIsAdding(false)
      toast.success('Decision created')
    },
    onError: () => toast.error('Failed to create decision'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api.patch(`/projects/${projectId}/decisions/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['decisions', projectId] })
      setEditingId(null)
      toast.success('Decision updated')
    },
    onError: () => toast.error('Failed to update decision'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/decisions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['decisions', projectId] })
      toast.success('Decision deleted')
    },
    onError: () => toast.error('Failed to delete decision'),
  })

  function quickStatus(id: string, status: DecisionStatus) {
    updateMutation.mutate({ id, body: { status } })
  }

  const filtered =
    filterStatus === 'all' ? decisions : decisions.filter((d) => d.status === filterStatus)

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as DecisionStatus | 'all')}
          className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="superseded">Superseded</option>
          <option value="rejected">Rejected</option>
        </select>
        <div className="ml-auto">
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm text-white transition-colors"
          >
            <Plus size={13} />
            Add decision
          </button>
        </div>
      </div>

      {isAdding && (
        <DecisionForm
          onSubmit={(data) => createMutation.mutate(data)}
          onCancel={() => setIsAdding(false)}
          isPending={createMutation.isPending}
          submitLabel="Create"
        />
      )}

      {isLoading && <div className="text-center py-10 text-sm text-gray-500">Loading…</div>}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-10 text-sm text-gray-500">
          No decisions yet.{' '}
          <button className="text-purple-400 hover:underline" onClick={() => setIsAdding(true)}>
            Record the first one
          </button>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((d) => {
          const isExpanded = expandedId === d.id
          const isEditing = editingId === d.id
          return (
            <div key={d.id} className="border border-gray-800 rounded-xl overflow-hidden bg-gray-900/50">
              {isEditing ? (
                <div className="p-3">
                  <DecisionForm
                    initial={{
                      title: d.title,
                      status: d.status,
                      context: d.context ?? '',
                      decision: d.decision,
                      reason: d.reason ?? '',
                      consequences: d.consequences ?? '',
                    }}
                    onSubmit={(data) => updateMutation.mutate({ id: d.id, body: data })}
                    onCancel={() => setEditingId(null)}
                    isPending={updateMutation.isPending}
                    submitLabel="Save"
                  />
                </div>
              ) : (
                <>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <span
                      className={`mt-0.5 text-xs px-2 py-0.5 rounded border font-medium shrink-0 ${STATUS_STYLES[d.status]}`}
                    >
                      {d.status}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{d.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{d.decision}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {d.status === 'draft' && (
                        <button
                          onClick={() => quickStatus(d.id, 'active')}
                          className="p-1.5 rounded-lg hover:bg-green-900/40 text-gray-400 hover:text-green-400 transition-colors"
                          title="Mark active"
                        >
                          <Check size={14} />
                        </button>
                      )}
                      {d.status === 'active' && (
                        <button
                          onClick={() => quickStatus(d.id, 'superseded')}
                          className="p-1.5 rounded-lg hover:bg-yellow-900/40 text-gray-400 hover:text-yellow-400 transition-colors"
                          title="Mark superseded"
                        >
                          <X size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : d.id)}
                        className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button
                        onClick={() => setEditingId(d.id)}
                        className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(d.id)}
                        disabled={deleteMutation.isPending}
                        className="p-1.5 rounded-lg hover:bg-red-900/50 text-gray-400 hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-800 px-4 py-3 space-y-2 text-sm">
                      {d.context && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Context</span>
                          <p className="text-gray-300 mt-0.5">{d.context}</p>
                        </div>
                      )}
                      <div>
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Decision</span>
                        <p className="text-gray-300 mt-0.5">{d.decision}</p>
                      </div>
                      {d.reason && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Reason</span>
                          <p className="text-gray-300 mt-0.5">{d.reason}</p>
                        </div>
                      )}
                      {d.consequences && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Consequences</span>
                          <p className="text-gray-300 mt-0.5">{d.consequences}</p>
                        </div>
                      )}
                      <p className="text-xs text-gray-600 pt-1">
                        {formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── GitHub Tab ────────────────────────────────────────────────────────────────

function GitHubTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()

  const { data: chunks = [], isLoading } = useQuery<MemoryChunk[]>({
    queryKey: ['memory-chunks-github', projectId],
    queryFn: () =>
      api
        .get(`/projects/${projectId}/memory`)
        .then((r) =>
          (r.data as MemoryChunk[]).filter((c) =>
            (['pull_request', 'code_file', 'commit'] as MemorySourceType[]).includes(c.source_type)
          )
        ),
  })

  const syncMutation = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/memory/sync-github`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['memory-chunks-github', projectId] })
      qc.invalidateQueries({ queryKey: ['memory-chunks', projectId] })
      const { synced_prs } = res.data as { synced_prs: number }
      toast.success(`Synced ${synced_prs} PR${synced_prs !== 1 ? 's' : ''}`)
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(msg || 'GitHub sync failed')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/memory/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory-chunks-github', projectId] })
      qc.invalidateQueries({ queryKey: ['memory-chunks', projectId] })
      toast.success('Removed')
    },
  })

  const TYPE_LABELS: Record<string, string> = {
    pull_request: 'PR',
    code_file: 'File',
    commit: 'Commit',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-400">
          Sync merged pull requests from the project's connected GitHub repository.
        </p>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm text-white transition-colors disabled:opacity-40 shrink-0"
        >
          <RefreshCw size={13} className={syncMutation.isPending ? 'animate-spin' : ''} />
          Sync GitHub
        </button>
      </div>

      {isLoading && <div className="text-center py-10 text-sm text-gray-500">Loading…</div>}

      {!isLoading && chunks.length === 0 && (
        <div className="text-center py-10 text-sm text-gray-500">
          No GitHub memory chunks yet. Click <strong>Sync GitHub</strong> to import merged PRs.
        </div>
      )}

      <div className="space-y-2">
        {chunks.map((chunk) => (
          <div
            key={chunk.id}
            className="flex items-start gap-3 border border-gray-800 rounded-xl px-4 py-3 bg-gray-900/50"
          >
            <GitMerge size={14} className="text-purple-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
                  {TYPE_LABELS[chunk.source_type] ?? chunk.source_type}
                  {chunk.source_id ? ` #${chunk.source_id}` : ''}
                </span>
                <ImportanceDot importance={chunk.importance} />
              </div>
              <p className="text-sm font-medium text-white mt-1">{chunk.title}</p>
              {chunk.summary && <p className="text-xs text-gray-400 mt-0.5">{chunk.summary}</p>}
            </div>
            <button
              onClick={() => deleteMutation.mutate(chunk.id)}
              disabled={deleteMutation.isPending}
              className="p-1.5 rounded-lg hover:bg-red-900/50 text-gray-500 hover:text-red-400 transition-colors shrink-0"
              title="Remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProjectMemoryPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('memory')

  const { data: project } = useQuery<{ name: string }>({
    queryKey: ['project-name', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then((r) => r.data),
    enabled: !!projectId,
  })

  const id = projectId!

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-gray-800 flex items-center gap-3">
        <button
          onClick={() => navigate(`/projects/${id}`)}
          className="text-gray-500 hover:text-white transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <Brain size={18} className="text-purple-400" />
        <div>
          <h1 className="text-white font-bold text-lg leading-tight">Project Memory</h1>
          {project?.name && (
            <p className="text-gray-500 text-xs mt-0.5">{project.name}</p>
          )}
        </div>

        {/* Tabs */}
        <div className="ml-auto flex items-center bg-gray-900 rounded-lg p-0.5 gap-0.5">
          <button
            onClick={() => setTab('memory')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
              tab === 'memory'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <BookOpen size={13} />
            Memory
          </button>
          <button
            onClick={() => setTab('decisions')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
              tab === 'decisions'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Check size={13} />
            Decisions
          </button>
          <button
            onClick={() => setTab('github')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
              tab === 'github'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <GitMerge size={13} />
            GitHub
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-6 py-6 max-w-4xl mx-auto w-full">
        {tab === 'memory' && <MemoryTab projectId={id} />}
        {tab === 'decisions' && <DecisionsTab projectId={id} />}
        {tab === 'github' && <GitHubTab projectId={id} />}
      </div>
    </div>
  )
}
