import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Team } from '../types'

interface TeamStore {
  teams: Team[]
  activeTeam: Team | null
  setTeams: (teams: Team[]) => void
  setActiveTeam: (team: Team | null) => void
  updateTeamModel: (teamId: string, model: string) => void
}

export const useTeamStore = create<TeamStore>()(
  persist(
    (set) => ({
      teams: [],
      activeTeam: null,
      setTeams: (teams) => set((s) => ({
        teams,
        // keep activeTeam in sync if it was updated
        activeTeam: s.activeTeam ? (teams.find((t) => t.id === s.activeTeam!.id) ?? teams[0] ?? null) : (teams[0] ?? null),
      })),
      setActiveTeam: (team) => set({ activeTeam: team }),
      updateTeamModel: (teamId, model) =>
        set((s) => ({
          teams: s.teams.map((t) => (t.id === teamId ? { ...t, default_ai_model: model } : t)),
          activeTeam: s.activeTeam?.id === teamId ? { ...s.activeTeam, default_ai_model: model } : s.activeTeam,
        })),
    }),
    { name: 'ownflow-team' }
  )
)
