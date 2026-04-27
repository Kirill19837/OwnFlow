import axios from 'axios'
import { useAuthStore } from '../store/authStore'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
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

export default api
