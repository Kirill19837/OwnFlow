import { create } from 'zustand'

interface LimitInfo {
    used?: number
    limit?: number
}

interface AiLimitStore {
    isOpen: boolean
    info: LimitInfo
    open: (info?: LimitInfo) => void
    close: () => void
}

export const useAiLimitStore = create<AiLimitStore>((set) => ({
    isOpen: false,
    info: {},
    open: (info = {}) => set({ isOpen: true, info }),
    close: () => set({ isOpen: false, info: {} }),
}))
