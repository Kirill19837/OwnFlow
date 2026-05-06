import { X, Plus, Pencil, Trash2, UserCheck, Wand2, CheckCircle2, GitPullRequest, HelpCircle } from 'lucide-react'

interface Command {
  icon: React.ReactNode
  label: string
  example: string
  description: string
}

const BOARD_COMMANDS: Command[] = [
  {
    icon: <Plus size={14} className="text-purple-400" />,
    label: 'Create tasks',
    example: '"Create tasks for user authentication feature"',
    description: `AI will suggest new tasks to add to the board. You confirm before they're created.`,
  },
  {
    icon: <Pencil size={14} className="text-blue-400" />,
    label: 'Update tasks',
    example: '"Change the login task priority to high and estimate 3h"',
    description: 'AI will propose changes to existing tasks. Review and apply with one click.',
  },
  {
    icon: <Trash2 size={14} className="text-red-400" />,
    label: 'Delete tasks',
    example: '"Remove all tasks related to the old design"',
    description: 'AI will identify tasks to remove. Confirm before deletion.',
  },
  {
    icon: <UserCheck size={14} className="text-green-400" />,
    label: 'Assign actor',
    example: '"Assign the frontend developer to the login task"',
    description: 'AI will match an actor to a task based on their role. Confirm to apply.',
  },
  {
    icon: <HelpCircle size={14} className="text-gray-400" />,
    label: 'Ask anything',
    example: `"What's the current sprint status?" or "Summarise in-progress tasks"`,
    description: 'Ask general questions about the project — AI will respond in plain text.',
  },
]

const TASK_COMMANDS: Command[] = [
  {
    icon: <Wand2 size={14} className="text-purple-400" />,
    label: 'Refine task',
    example: '"Refine this task" or "Add more detail to the description"',
    description: 'AI will enrich the task description, clarify scope, and suggest acceptance criteria.',
  },
  {
    icon: <CheckCircle2 size={14} className="text-green-400" />,
    label: 'Mark as AI ready',
    example: '"This task is ready to be executed"',
    description: 'When AI is satisfied with the task definition, it will mark it as AI ready automatically.',
  },
  {
    icon: <GitPullRequest size={14} className="text-amber-400" />,
    label: 'Validate results',
    example: '"Did the agent implement this correctly?"',
    description: 'After an agent runs, ask AI to review the deliverables and flag any issues.',
  },
  {
    icon: <HelpCircle size={14} className="text-gray-400" />,
    label: 'Ask anything',
    example: '"What are the edge cases here?" or "Suggest a better approach"',
    description: 'Chat freely with the AI actor assigned to this task.',
  },
]

interface Props {
  context: 'board' | 'task'
  onClose: () => void
  onCommandClick?: (example: string) => void
}

export function AiCommandsModal({ context, onClose, onCommandClick }: Props) {
  const commands = context === 'board' ? BOARD_COMMANDS : TASK_COMMANDS
  const title = context === 'board' ? 'Board AI — available commands' : 'Task AI — available commands'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
          <HelpCircle size={16} className="text-purple-400 shrink-0" />
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="ml-auto text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Commands */}
        <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto">
          {commands.map((cmd) => (
            <button
              key={cmd.label}
              onClick={() => {
                if (onCommandClick) {
                  // Strip surrounding quotes for insertion
                  const raw = cmd.example.replace(/^"|"$/g, '').replace(/^'|'$/g, '')
                  onCommandClick(raw)
                }
                onClose()
              }}
              className="w-full text-left bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-xl px-4 py-3 transition-colors group"
            >
              <div className="flex items-center gap-2 mb-1">
                {cmd.icon}
                <span className="text-xs font-semibold text-white">{cmd.label}</span>
              </div>
              <p className="text-xs text-purple-300 font-mono mb-1 group-hover:text-purple-200 transition-colors">
                {cmd.example}
              </p>
              <p className="text-xs text-gray-500">{cmd.description}</p>
            </button>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-gray-800">
          <p className="text-xs text-gray-600">Click a command to prefill the input, or type freely.</p>
        </div>
      </div>
    </div>
  )
}
