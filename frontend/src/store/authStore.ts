import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import api from '../lib/api'

export type LinkType = 'create_company' | 'join_company' | 'set_password' | null

interface AuthStore {
  session: Session | null
  loading: boolean
  needsPassword: boolean
  needsName: boolean
  linkType: LinkType
  setSession: (s: Session | null) => void
  setNeedsPassword: (v: boolean) => void
  setNeedsName: (v: boolean) => void
  setLinkType: (v: LinkType) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, name: string) => Promise<{ confirmationSent: true }>
  signOut: () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set) => ({
  session: null,
  loading: true,
  needsPassword: false,
  needsName: false,
  linkType: null,
  setSession: (session) => set({ session, loading: false }),
  setNeedsPassword: (needsPassword) => set({ needsPassword }),
  setNeedsName: (needsName) => set({ needsName }),
  setLinkType: (linkType) => set({ linkType }),
  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  },
  signUp: async (email, name) => {
    // Route through our backend so Postmark sends the confirmation email
    // (bypasses Supabase's rate-limited mailer). Password is auto-generated
    // server-side; user sets their own later via the SetPasswordModal flow.
    const res = await api.post('/auth/signup', { email, name })
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
