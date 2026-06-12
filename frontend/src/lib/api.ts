import axios from 'axios'
import { useAuthStore } from '../store/authStore'
import { useAiLimitStore } from '../store/aiLimitStore'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
})

// Attach the Supabase session JWT to every request so the backend can verify
// the caller's identity without trusting client-supplied user IDs.
// Read from the Zustand store (in-memory, always current via onAuthStateChange)
// instead of calling supabase.auth.getSession() to avoid storage-lock contention
// when many parallel requests are in flight simultaneously.
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().session?.access_token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Intercept HTTP 402 (AI prompt limit reached) and open the upgrade modal.
api.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 402) {
        const detail: string = error.response.data?.detail ?? ''
        const match = detail.match(/(\d+)\/(\d+)/)
        useAiLimitStore.getState().open(
            match ? { used: Number(match[1]), limit: Number(match[2]) } : {}
        )
      }
      return Promise.reject(error)
    }
)

export default api
