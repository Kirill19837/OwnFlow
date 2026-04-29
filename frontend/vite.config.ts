import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return

          if (id.includes('react') || id.includes('scheduler')) return 'react-vendor'
          if (id.includes('@tanstack') || id.includes('zustand')) return 'state-vendor'
          if (id.includes('@supabase')) return 'supabase-vendor'
          if (id.includes('react-router')) return 'router-vendor'
          if (id.includes('lucide-react')) return 'icons-vendor'
          if (id.includes('date-fns')) return 'date-vendor'
          if (id.includes('@hello-pangea')) return 'dnd-vendor'
          if (id.includes('react-markdown')) return 'markdown-vendor'

          return 'vendor'
        },
      },
    },
  },
})
