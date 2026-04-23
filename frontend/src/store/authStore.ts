import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import api from '../lib/api'

interface AuthStore {
  session: Session | null
  loading: boolean
  needsPassword: boolean
  setSession: (s: Session | null) => void
  setNeedsPassword: (v: boolean) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<{ confirmationSent: true }>
  signOut: () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set) => ({
  session: null,
  loading: true,
  needsPassword: false,
  setSession: (session) => set({ session, loading: false }),
  setNeedsPassword: (needsPassword) => set({ needsPassword }),
  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  },
  signUp: async (email, password) => {
    // Route through our backend so Postmark sends the confirmation email
    // (bypasses Supabase's rate-limited mailer).
    const res = await api.post('/auth/signup', { email, password })
    if (res.data?.status !== 'confirmation_sent') {
      throw new Error('Signup failed — please try again.')
    }
    return { confirmationSent: true }
  },
  signOut: async () => {
    await supabase.auth.signOut()
    set({ session: null })
  },
}))
