import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { RefreshCw, Trash2, X } from 'lucide-react'

const LOG_LEVEL_STYLE: Record<number, string> = {
  0: 'text-gray-500',
  1: 'text-gray-300',
  2: 'text-yellow-400',
  3: 'text-red-400',
}
const LOG_LEVEL_LABEL: Record<number, string> = { 0: 'DBG', 1: 'INF', 2: 'WRN', 3: 'ERR' }

interface AiLog {
  id: string
  level: number
  message: string
}

interface Props {
  scopeParams: Record<string, string>
  teamName?: string
  onClose: () => void
  onCleared: () => void
}

export default function ClearAiLogsModal({ scopeParams, teamName, onClose, onCleared }: Props) {
  const queryClient = useQueryClient()

  const { data, isFetching } = useQuery<{ logs: AiLog[]; total: number }>({
    queryKey: ['ai-logs-all', scopeParams],
    queryFn: () =>
      api
        .get('/projects/dashboard/ai-logs', {
          params: { ...scopeParams, limit: 9999, offset: 0, level: -1, phase: -1 },
        })
        .then((r) => r.data),
  })

  const clearMutation = useMutation({
    mutationFn: () => api.delete('/projects/dashboard/ai-logs', { params: scopeParams }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-logs'] })
      queryClient.removeQueries({ queryKey: ['ai-logs-all'] })
      onCleared()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Trash2 size={16} className="text-red-400" />
            <span className="text-sm font-semibold text-white">Clear AI Logs</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4">
          {isFetching ? (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-4 justify-center">
              <RefreshCw size={14} className="animate-spin" />
              Loading full context…
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-300 mb-3">
                This will permanently delete{' '}
                <span className="font-semibold text-white">
                  {data?.total ?? 0} log{(data?.total ?? 0) !== 1 ? 's' : ''}
                </span>
                {teamName ? ` for team "${teamName}"` : ''}.
              </p>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950 divide-y divide-gray-800/60 mb-4">
                {(data?.logs ?? []).length === 0 ? (
                  <p className="text-xs text-gray-500 px-3 py-3">No logs to display.</p>
                ) : (
                  (data?.logs ?? []).map((log) => (
                    <div key={log.id} className="flex items-start gap-2 px-3 py-1.5">
                      <span
                        className={`shrink-0 text-[10px] font-mono font-semibold w-8 ${LOG_LEVEL_STYLE[log.level] ?? 'text-gray-400'}`}
                      >
                        {LOG_LEVEL_LABEL[log.level] ?? log.level}
                      </span>
                      <p className="text-xs font-mono text-gray-400 leading-snug break-all">
                        {log.message}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-800 bg-gray-900/60">
          <button
            onClick={onClose}
            disabled={clearMutation.isPending}
            className="px-4 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => clearMutation.mutate()}
            disabled={isFetching || clearMutation.isPending || (data?.total ?? 0) === 0}
            className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-sm text-white font-medium transition-colors disabled:opacity-50"
          >
            {clearMutation.isPending ? 'Clearing…' : 'Clear all logs'}
          </button>
        </div>
      </div>
    </div>
  )
}
