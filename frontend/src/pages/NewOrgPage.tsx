import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useOrgStore } from '../store/orgStore'
import api from '../lib/api'
import type { Organization } from '../types'
import { ChevronLeft, Building2 } from 'lucide-react'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (OpenAI)' },
  { value: 'o3-mini', label: 'o3-mini (OpenAI)' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Anthropic)' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Anthropic)' },
]

export default function NewOrgPage() {
  const { session } = useAuthStore()
  const { setActiveOrg } = useOrgStore()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [model, setModel] = useState('gpt-4o')

  const create = useMutation({
    mutationFn: () =>
      api.post<Organization>('/orgs', {
        name,
        owner_id: session!.user.id,
        default_ai_model: model,
      }).then((r) => r.data),
    onSuccess: (org) => {
      setActiveOrg(org)
      qc.invalidateQueries({ queryKey: ['orgs'] })
      navigate('/')
    },
  })

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-10">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors">
        <ChevronLeft size={16} /> Back
      </button>

      <div className="flex items-center gap-3 mb-8">
        <Building2 size={28} className="text-purple-400" />
        <div>
          <h1 className="text-2xl font-bold text-white">New Organization</h1>
          <p className="text-gray-400 text-sm">A workspace for your team and projects</p>
        </div>
      </div>

      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Organization name</label>
          <input
            type="text"
            placeholder="Acme Corp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Default AI model</label>
          <p className="text-xs text-gray-500 mb-2">Used for task breakdown and AI actors unless overridden per project</p>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            {AI_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>

        {create.isError && (
          <p className="text-red-400 text-sm">{(create.error as any)?.message}</p>
        )}

        <button
          onClick={() => create.mutate()}
          disabled={create.isPending || !name.trim()}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors"
        >
          {create.isPending ? 'Creating…' : 'Create organization'}
        </button>
      </div>
    </div>
  )
}
