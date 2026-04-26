import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, ProtectedRoute } from './components/Auth'
import AppLayout from './components/AppLayout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import NewProjectPage from './pages/NewProjectPage'
import ProjectBoardPage from './pages/ProjectBoardPage'
import NewOrgPage from './pages/NewOrgPage'
import NewCompanyPage from './pages/NewCompanyPage'
import OrgSettingsPage from './pages/OrgSettingsPage'
import ProjectActivityPage from './pages/ProjectActivityPage'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AuthProvider />}>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/company/new" element={<NewCompanyPage />} />
              <Route element={<AppLayout />}>
                <Route index element={<DashboardPage />} />
                <Route path="/new" element={<NewProjectPage />} />
                <Route path="/projects/:projectId" element={<ProjectBoardPage />} />
                <Route path="/projects/:projectId/activity" element={<ProjectActivityPage />} />
                <Route path="/teams/new" element={<NewOrgPage />} />
                <Route path="/teams/:orgId/settings" element={<OrgSettingsPage />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster position="bottom-right" toastOptions={{ style: { background: '#1f2937', color: '#fff', border: '1px solid #374151' } }} />
    </QueryClientProvider>
  )
}


