import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import { formatDistanceToNow } from 'date-fns'
import { ScrollText, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'

const LOG_LEVEL_STYLE: Record<number, string> = {
  0: 'text-gray-500',
  1: 'text-gray-300',
  2: 'text-yellow-400',
  3: 'text-red-400',
}
const LOG_LEVEL_LABEL: Record<number, string> = { 0: 'DBG', 1: 'INF', 2: 'WRN', 3: 'ERR' }
const LOG_LEVEL_BG: Record<number, string> = {
  0: 'bg-gray-800 text-gray-400',
  1: 'bg-gray-700 text-gray-200',
  2: 'bg-yellow-900/50 text-yellow-300',
  3: 'bg-red-900/50 text-red-300',
}
const LOG_PHASE_LABEL: Record<number, string> = {
  0: 'planning',
  1: 'exec',
  2: 'ext-dispatch',
  3: 'docker',
  4: 'task-exec',
}

interface AiLog {
  id: string
  project_id: string
  project_name: string
  task_id: string | null
  task_title: string | null
  phase: number
  level: number
  message: string
  created_at: string
}

const LIMIT = 100

const LEVEL_OPTIONS = [
  { value: -1, label: 'All levels' },
  { value: 0, label: 'Debug' },
  { value: 1, label: 'Info' },
  { value: 2, label: 'Warning' },
  { value: 3, label: 'Error' },
]

const PHASE_OPTIONS = [
  { value: -1, label: 'All phases' },
  { value: 0, label: 'Planning' },
  { value: 1, label: 'Execution' },
  { value: 2, label: 'Ext-dispatch' },
  { value: 3, label: 'Docker' },
  { value: 4, label: 'Task-exec' },
]

export default function AiLogsPage() {
  const { session } = useAuthStore()
  const { activeTeam } = useTeamStore()

  const [levelFilter, setLevelFilter] = useState(-1)
  const [phaseFilter, setPhaseFilter] = useState(-1)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState('')

  const params: Record<string, string | number> = {
    limit: LIMIT,
    offset,
    level: levelFilter,
    phase: phaseFilter,
  }
  if (activeTeam) {
    params.team_id = activeTeam.id
  } else if (session?.user.id) {
    params.owner_id = session.user.id
  }

  const { data, isFetching, refetch } = useQuery<{ logs: AiLog[]; total: number }>({
    queryKey: ['ai-logs', activeTeam?.id, session?.user.id, levelFilter, phaseFilter, offset],
    queryFn: () => api.get('/projects/dashboard/ai-logs', { params }).then((r) => r.data),
    enabled: !!session,
  })

  const logs = data?.logs ?? []

  const filtered = search.trim()
    ? logs.filter(
        (l) =>
          l.message.toLowerCase().includes(search.toLowerCase()) ||
          l.project_name.toLowerCase().includes(search.toLowerCase()) ||
          (l.task_title ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : logs

  function resetFilters() {
    setLevelFilter(-1)
    setPhaseFilter(-1)
    setOffset(0)
    setSearch('')
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <ScrollText size={20} className="text-purple-400" />
          <h1 className="text-xl font-bold text-white">AI Logs</h1>
          {activeTeam && (
            <span className="text-xs text-gray-500 ml-1">— {activeTeam.name}</span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="text"
          placeholder="Search messages, projects, tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500"
        />
        <select
          value={levelFilter}
          onChange={(e) => { setLevelFilter(Number(e.target.value)); setOffset(0) }}
          className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
        >
          {LEVEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={phaseFilter}
          onChange={(e) => { setPhaseFilter(Number(e.target.value)); setOffset(0) }}
          className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
        >
          {PHASE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {(levelFilter !== -1 || phaseFilter !== -1 || search) && (
          <button
            onClick={resetFilters}
            className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Log table */}
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <div className="grid grid-cols-[auto_auto_1fr_auto] gap-0 text-xs text-gray-500 uppercase tracking-wide px-4 py-2 border-b border-gray-800 bg-gray-900">
          <span className="w-14">Level</span>
          <span className="w-24 ml-3">Phase</span>
          <span className="ml-3">Message / Context</span>
          <span className="text-right">Time</span>
        </div>

        {isFetching && filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-gray-500">Loading…</div>
        )}

        {!isFetching && filtered.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-gray-500">
            No logs found
            {(levelFilter !== -1 || phaseFilter !== -1 || search) && (
              <button onClick={resetFilters} className="ml-2 text-purple-400 hover:underline">
                clear filters
              </button>
            )}
          </div>
        )}

        <div className="divide-y divide-gray-800/60">
          {filtered.map((log) => (
            <div
              key={log.id}
              className="grid grid-cols-[auto_auto_1fr_auto] gap-0 items-start px-4 py-2.5 hover:bg-gray-900/60 transition-colors"
            >
              {/* Level badge */}
              <span className={`inline-flex items-center justify-center w-11 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold ${LOG_LEVEL_BG[log.level] ?? 'bg-gray-800 text-gray-400'}`}>
                {LOG_LEVEL_LABEL[log.level] ?? log.level}
              </span>

              {/* Phase */}
              <span className="ml-3 w-24 shrink-0 text-xs text-gray-500 font-mono pt-0.5">
                {LOG_PHASE_LABEL[log.phase] ?? log.phase}
              </span>

              {/* Message + context */}
              <div className="ml-3 min-w-0">
                <p className={`text-sm font-mono leading-snug break-all ${LOG_LEVEL_STYLE[log.level] ?? 'text-gray-300'}`}>
                  {log.message}
                </p>
                <div className="flex flex-wrap gap-x-3 mt-0.5">
                  <span className="text-[11px] text-gray-600">{log.project_name}</span>
                  {log.task_title && (
                    <span className="text-[11px] text-gray-600">· {log.task_title}</span>
                  )}
                </div>
              </div>

              {/* Timestamp */}
              <span className="ml-4 text-[11px] text-gray-600 whitespace-nowrap pt-0.5">
                {log.created_at
                  ? formatDistanceToNow(new Date(log.created_at), { addSuffix: true })
                  : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Pagination */}
      {(offset > 0 || (data?.total ?? 0) >= LIMIT) && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-400">
          <button
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-xs text-gray-500">
            Showing {offset + 1}–{offset + filtered.length}
          </span>
          <button
            disabled={(data?.total ?? 0) < LIMIT}
            onClick={() => setOffset((o) => o + LIMIT)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
