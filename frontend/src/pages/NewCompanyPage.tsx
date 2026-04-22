import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useCompanyStore } from '../store/companyStore'
import { useOrgStore } from '../store/orgStore'
import api from '../lib/api'
import { Building2, Layers } from 'lucide-react'
import type { Organization } from '../types'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (OpenAI)' },
  { value: 'o3-mini', label: 'o3-mini (OpenAI)' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Anthropic)' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Anthropic)' },
]

export default function NewCompanyPage() {
  const { session } = useAuthStore()
  const { setCompany } = useCompanyStore()
  const { setOrgs, setActiveOrg } = useOrgStore()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [model, setModel] = useState('gpt-4o')

  const create = useMutation({
    mutationFn: () =>
      api.post('/companies', {
        name: name.trim(),
        owner_id: session!.user.id,
        default_ai_model: model,
      }).then((r) => r.data),
    onSuccess: (data) => {
      setCompany(data)
      // Backend auto-creates a first team with the same name
      if (data.default_team_id) {
        const team: Organization = {
          id: data.default_team_id,
          name: data.name,
          slug: `${data.slug}-team`,
          owner_id: data.owner_id,
          company_id: data.id,
          default_ai_model: model,
          created_at: data.created_at,
          my_role: 'owner',
        }
        setOrgs([team])
        setActiveOrg(team)
      }
      navigate('/')
    },
  })

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
      <div className="flex items-center gap-2 font-bold text-lg text-purple-400 mb-10">
        <Layers size={20} />
        OwnFlow
      </div>

      <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-2xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <Building2 size={24} className="text-purple-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Set up your company</h1>
            <p className="text-gray-400 text-sm mt-0.5">Your company workspace — teams and projects live inside it</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Company name</label>
            <input
              type="text"
              placeholder="Acme Corp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && create.mutate()}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Default AI model</label>
            <p className="text-xs text-gray-500 mb-2">Used for AI actors unless overridden per project</p>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              {AI_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {create.isError && (
            <p className="text-red-400 text-sm">Something went wrong. Please try again.</p>
          )}

          <button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors mt-2"
          >
            {create.isPending ? 'Creating…' : 'Create company & first team →'}
          </button>
        </div>
      </div>
    </div>
  )
}
