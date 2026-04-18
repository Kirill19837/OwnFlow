/**
 * Read-only renderer for assistant messages in the Activity log.
 * Shows action cards (update_description, update_details, mark_ready, etc.)
 * without action buttons — these are historical records already applied.
 */
import { FileText, ListChecks, CheckCircle2, RefreshCw, UserCheck, Play } from 'lucide-react'
import { parseAllTaskActions, stripActionBlocks, type TaskAction } from '../lib/taskActions'

interface Props {
  content: string
}

function ReadonlyActionCard({ action }: { action: TaskAction }) {
  if (action.intent === 'assign_actor') {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-1.5">
        <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <UserCheck size={11} /> Assign task
        </p>
        <p className="text-sm text-white">{action.actor_name}</p>
      </div>
    )
  }

  if (action.intent === 'update_status') {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-1.5">
        <p className="text-xs text-yellow-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <RefreshCw size={11} /> Update status
        </p>
        <p className="text-sm text-white capitalize">{action.status.replace('_', ' ')}</p>
      </div>
    )
  }

  if (action.intent === 'update_description') {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-1.5">
        <p className="text-xs text-teal-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <FileText size={11} /> Updated description
        </p>
        {action.title && (
          <p className="text-xs font-semibold text-white bg-gray-950 rounded px-2 py-1">
            📝 {action.title}
          </p>
        )}
        <div className="text-xs text-gray-300 bg-gray-950 rounded-lg px-2 py-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
          {action.content}
        </div>
      </div>
    )
  }

  if (action.intent === 'update_details') {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-1.5">
        <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <ListChecks size={11} /> Saved decisions
        </p>
        <div className="space-y-1">
          {Object.entries(action.details).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-xs bg-gray-950 rounded px-2 py-1">
              <span className="text-gray-400 capitalize min-w-[100px] shrink-0">{k.replace(/_/g, ' ')}</span>
              <span className="text-gray-200">{v}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (action.intent === 'mark_ready') {
    return (
      <div className="bg-gray-900 border border-green-800/50 rounded-xl p-3 space-y-1.5">
        <p className="text-xs text-green-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <CheckCircle2 size={11} /> Marked as ready
        </p>
        {action.summary && <p className="text-xs text-gray-300">{action.summary}</p>}
      </div>
    )
  }

  if (action.intent === 'execute_task') {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-1.5">
        <p className="text-xs text-purple-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <Play size={11} /> Execute task
        </p>
      </div>
    )
  }

  return null
}

export default function AssistantMessage({ content }: Props) {
  const actions = parseAllTaskActions(content)
  const prose = stripActionBlocks(content)

  if (actions.length === 0) {
    return (
      <div className="bg-gray-900 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap break-words">
        {content}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {actions.map((action, i) => (
        <ReadonlyActionCard key={i} action={action} />
      ))}
      {prose && (
        <div className="bg-gray-900 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap break-words">
          {prose}
        </div>
      )}
    </div>
  )
}
