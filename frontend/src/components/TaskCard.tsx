import type { Task, Actor, Assignment } from '../types'
import { cn } from '../lib/utils'
import { Bot, User, Clock, CheckCircle2, GitPullRequest, Sparkles } from 'lucide-react'

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-gray-500',
  medium: 'bg-yellow-400',
  high: 'bg-orange-400',
  critical: 'bg-red-500',
}

interface Props {
  task: Task
  actors: Actor[]
  onClick: () => void
}

export default function TaskCard({ task, actors, onClick }: Props) {
  // Supabase returns assignments as {} (object) not [] when there's a unique constraint
  const firstAssignment = Array.isArray(task.assignments)
    ? task.assignments[0]
    : (task.assignments as unknown as Assignment)
  const assignedActor = actors.find((a) => a.id === firstAssignment?.actor_id)

  return (
    <div
      onClick={onClick}
      className="bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-lg p-3 cursor-pointer transition-all group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-white text-sm font-medium leading-tight group-hover:text-purple-300 transition-colors">
          {task.title}
        </span>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {task.is_ready && (
            <CheckCircle2 size={13} className="text-green-400" aria-label="Ready for implementation" />
          )}
          {!task.is_ready && task.ai_ready && (
            <Sparkles size={13} className="text-yellow-400" aria-label="AI ready — awaiting your approval" />
          )}
          {task.github_pr_url && (
            <a
              href={task.github_pr_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="View PR on GitHub"
            >
              <GitPullRequest size={13} className="text-purple-400 hover:text-purple-300" />
            </a>
          )}
          <span
            className={cn('w-2 h-2 rounded-full', PRIORITY_DOT[task.priority])}
            title={task.priority}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{task.type}</span>
        <div className="flex items-center gap-1.5">
          <Clock size={11} className="text-gray-600" />
          <span className="text-xs text-gray-500">{task.estimated_hours}h</span>
          {assignedActor ? (
            <span className="flex items-center gap-0.5 text-xs text-gray-400 ml-1">
              {assignedActor.type === 'ai' ? (
                <Bot size={12} className="text-purple-400" />
              ) : (
                <User size={12} className="text-blue-400" />
              )}
              <span className="max-w-[70px] truncate">{assignedActor.name}</span>
            </span>
          ) : (
            <span className="text-xs text-gray-600 ml-1">unassigned</span>
          )}
        </div>
      </div>
    </div>
  )
}
