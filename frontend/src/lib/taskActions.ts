export type TaskAction =
  | { intent: 'assign_actor'; actor_id: string; actor_name: string }
  | { intent: 'update_status'; status: string }
  | { intent: 'execute_task'; confirm: boolean }
  | { intent: 'update_description'; title?: string; content: string }
  | { intent: 'update_details'; details: Record<string, string> }
  | { intent: 'mark_ready'; summary: string }

const SUPPORTED_INTENTS = [
  'assign_actor',
  'update_status',
  'execute_task',
  'update_description',
  'update_details',
  'mark_ready',
]

/** Extract every fenced JSON action block from an assistant message. */
export function parseAllTaskActions(content: string): TaskAction[] {
  const re = /```json\s*([\s\S]*?)```/g
  const actions: TaskAction[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim())
      if (SUPPORTED_INTENTS.includes(parsed.intent)) {
        actions.push(parsed as TaskAction)
      }
    } catch { /* invalid JSON — skip */ }
  }
  return actions
}

/** Strip all fenced JSON blocks, returning only the remaining prose. */
export function stripActionBlocks(content: string): string {
  return content.replace(/```json[\s\S]*?```/g, '').trim()
}
