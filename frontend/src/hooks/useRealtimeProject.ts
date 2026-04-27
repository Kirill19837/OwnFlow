import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useProjectStore } from '../store/projectStore'
import type { Task, Assignment, Project } from '../types'

export function useRealtimeProject(projectId: string | undefined) {
  const upsertTask = useProjectStore((state) => state.upsertTask)
  const upsertAssignment = useProjectStore((state) => state.upsertAssignment)
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    if (!projectId) return

    const channel = supabase
      .channel(`project:${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
        (payload) => {
          if (payload.new) upsertTask(payload.new as Task)
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assignments' },
        (payload) => {
          if (payload.new) upsertAssignment(payload.new as Assignment)
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` },
        (payload) => {
          const currentProject = useProjectStore.getState().currentProject
          if (payload.new && currentProject) {
            setCurrentProject({ ...currentProject, ...(payload.new as Partial<Project>) })
          }
        }
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [projectId, setCurrentProject, upsertAssignment, upsertTask])
}
