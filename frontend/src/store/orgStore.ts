import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Organization } from '../types'

interface OrgStore {
  orgs: Organization[]
  activeOrg: Organization | null
  setOrgs: (orgs: Organization[]) => void
  setActiveOrg: (org: Organization | null) => void
  updateOrgModel: (orgId: string, model: string) => void
}

export const useOrgStore = create<OrgStore>()(
  persist(
    (set) => ({
      orgs: [],
      activeOrg: null,
      setOrgs: (orgs) => set((s) => ({
        orgs,
        // keep activeOrg in sync if it was updated
        activeOrg: s.activeOrg ? (orgs.find((o) => o.id === s.activeOrg!.id) ?? orgs[0] ?? null) : (orgs[0] ?? null),
      })),
      setActiveOrg: (org) => set({ activeOrg: org }),
      updateOrgModel: (orgId, model) =>
        set((s) => ({
          orgs: s.orgs.map((o) => (o.id === orgId ? { ...o, default_ai_model: model } : o)),
          activeOrg: s.activeOrg?.id === orgId ? { ...s.activeOrg, default_ai_model: model } : s.activeOrg,
        })),
    }),
    { name: 'ownflow-org' }
  )
)
