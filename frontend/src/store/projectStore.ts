import { create } from 'zustand'
import type { Project, Task, Assignment } from '../types'

interface ProjectStore {
  projects: Project[]
  currentProject: Project | null
  setProjects: (p: Project[]) => void
  setCurrentProject: (p: Project | null) => void
  upsertTask: (task: Task) => void
  upsertAssignment: (assignment: Assignment) => void
}

export const useProjectStore = create<ProjectStore>((set) => ({
  projects: [],
  currentProject: null,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (currentProject) => set({ currentProject }),
  upsertTask: (task) =>
    set((state) => {
      if (!state.currentProject) return state
      const tasks = state.currentProject.tasks ?? []
      const idx = tasks.findIndex((t) => t.id === task.id)
      // Real-time row events don't include joined data (assignments, actors).
      // Preserve existing assignments when the incoming payload omits them.
      const merged = idx >= 0
        ? { ...tasks[idx], ...task, assignments: task.assignments ?? tasks[idx].assignments }
        : task
      const updated = idx >= 0 ? tasks.map((t) => (t.id === task.id ? merged : t)) : [...tasks, task]
      return { currentProject: { ...state.currentProject, tasks: updated } }
    }),
  upsertAssignment: (assignment) =>
    set((state) => {
      if (!state.currentProject) return state
      const tasks = (state.currentProject.tasks ?? []).map((t) => {
        if (t.id !== assignment.task_id) return t
        const existing = Array.isArray(t.assignments) ? t.assignments : []
        const idx = existing.findIndex((a) => a.id === assignment.id)
        const updatedAssignments =
          idx >= 0 ? existing.map((a) => (a.id === assignment.id ? assignment : a)) : [...existing, assignment]
        return { ...t, assignments: updatedAssignments }
      })
      return { currentProject: { ...state.currentProject, tasks } }
    }),
}))
