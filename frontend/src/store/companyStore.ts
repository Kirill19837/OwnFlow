import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Company } from '../types'

interface CompanyStore {
  company: Company | null
  setCompany: (company: Company | null) => void
}

export const useCompanyStore = create<CompanyStore>()(
  persist(
    (set) => ({
      company: null,
      setCompany: (company) => set({ company }),
    }),
    { name: 'ownflow-company' }
  )
)
