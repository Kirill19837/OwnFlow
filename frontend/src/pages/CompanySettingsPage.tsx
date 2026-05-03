import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Building2, Pencil, Check, Trash2, Key, Bot } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useCompanyStore } from '../store/companyStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import toast from 'react-hot-toast'

export default function CompanySettingsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { session } = useAuthStore()
  const { company, setCompany } = useCompanyStore()
  const { setTeams, setActiveTeam } = useTeamStore()

  const userId = session?.user?.id ?? ''
  const isOwner = !!company && company.owner_id === userId

  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingPhone, setEditingPhone] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingOpenAI, setEditingOpenAI] = useState(false)
  const [newOpenAIKey, setNewOpenAIKey] = useState('')
  const [editingAnthropic, setEditingAnthropic] = useState(false)
  const [newAnthropicKey, setNewAnthropicKey] = useState('')

  const rename = useMutation({
    mutationFn: (name: string) =>
      api.patch(`/companies/${company!.id}`, { name }, { params: { user_id: userId } }),
    onSuccess: (_, name) => {
      const updated = { ...company!, name }
      setCompany(updated)
      qc.setQueryData(['company', userId], updated)
      setRenaming(false)
      toast.success('Company renamed')
    },
    onError: () => toast.error('Failed to rename'),
  })

  const updatePhone = useMutation({
    mutationFn: (phone: string) =>
      api.patch(`/companies/${company!.id}`, { phone }, { params: { user_id: userId } }),
    onSuccess: (_, phone) => {
      const updated = { ...company!, phone }
      setCompany(updated)
      qc.setQueryData(['company', userId], updated)
      setEditingPhone(false)
      toast.success('Phone updated')
    },
    onError: () => toast.error('Failed to update phone'),
  })

  const updateOpenAIKey = useMutation({
    mutationFn: (openai_api_key: string) =>
      api.patch(`/companies/${company!.id}`, { openai_api_key }, { params: { user_id: userId } }),
    onSuccess: () => {
      setEditingOpenAI(false)
      setNewOpenAIKey('')
      toast.success('OpenAI key saved')
    },
    onError: () => toast.error('Failed to save key'),
  })

  const updateAnthropicKey = useMutation({
    mutationFn: (anthropic_api_key: string) =>
      api.patch(`/companies/${company!.id}`, { anthropic_api_key }, { params: { user_id: userId } }),
    onSuccess: () => {
      setEditingAnthropic(false)
      setNewAnthropicKey('')
      toast.success('Anthropic key saved')
    },
    onError: () => toast.error('Failed to save key'),
  })

  const deleteCompany = useMutation({
    mutationFn: () =>
      api.delete(`/companies/${company!.id}`, { params: { user_id: userId } }),
    onSuccess: () => {
      setCompany(null)
      setTeams([])
      setActiveTeam(null)
      qc.removeQueries({ queryKey: ['company', userId] })
      qc.removeQueries({ queryKey: ['teams'] })
      navigate('/company/new', { replace: true })
    },
    onError: () => toast.error('Failed to delete company'),
  })

  if (!company) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        No company found.
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-400 mb-4">Only the company owner can access this page.</p>
          <button onClick={() => navigate('/')} className="text-purple-400 hover:text-purple-300 text-sm">
            ← Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto w-full px-6 py-10">
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
      >
        <ChevronLeft size={16} /> Back
      </button>

      <div className="flex items-center gap-3 mb-8">
        <Building2 size={24} className="text-purple-400" />
        <div>
          <h1 className="text-2xl font-bold text-white">{company.name}</h1>
          <p className="text-gray-500 text-sm">Company settings</p>
        </div>
      </div>

      <div className="space-y-6">

        {/* Rename */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-4">Company name</h2>
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) rename.mutate(newName.trim())
                  if (e.key === 'Escape') setRenaming(false)
                }}
                className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
              />
              <button
                onClick={() => newName.trim() && rename.mutate(newName.trim())}
                disabled={!newName.trim() || rename.isPending}
                className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
              >
                <Check size={14} /> Save
              </button>
              <button onClick={() => setRenaming(false)} className="text-sm text-gray-400 hover:text-white">
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-white">{company.name}</span>
              <button
                onClick={() => { setNewName(company.name); setRenaming(true) }}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
              >
                <Pencil size={13} /> Rename
              </button>
            </div>
          )}
        </section>

        {/* Phone */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-4">Contact phone</h2>
          {editingPhone ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                type="tel"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPhone.trim()) updatePhone.mutate(newPhone.trim())
                  if (e.key === 'Escape') setEditingPhone(false)
                }}
                className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
              />
              <button
                onClick={() => newPhone.trim() && updatePhone.mutate(newPhone.trim())}
                disabled={!newPhone.trim() || updatePhone.isPending}
                className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
              >
                <Check size={14} /> Save
              </button>
              <button onClick={() => setEditingPhone(false)} className="text-sm text-gray-400 hover:text-white">
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-white">{(company as { phone?: string }).phone ?? <span className="text-gray-500 italic">Not set</span>}</span>
              <button
                onClick={() => { setNewPhone((company as { phone?: string }).phone ?? ''); setEditingPhone(true) }}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
              >
                <Pencil size={13} /> Edit
              </button>
            </div>
          )}
        </section>

        {/* AI API Keys */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Key size={15} className="text-purple-400" /> AI provider keys
          </h2>
          <p className="text-gray-500 text-xs -mt-2">
            These keys are used by built-in AI actors across all projects in your company.
          </p>

          {/* OpenAI */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">OpenAI API key</label>
            {editingOpenAI ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  type="password"
                  value={newOpenAIKey}
                  onChange={(e) => setNewOpenAIKey(e.target.value)}
                  placeholder="sk-..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newOpenAIKey.trim()) updateOpenAIKey.mutate(newOpenAIKey.trim())
                    if (e.key === 'Escape') setEditingOpenAI(false)
                  }}
                  className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none"
                />
                <button
                  onClick={() => newOpenAIKey.trim() && updateOpenAIKey.mutate(newOpenAIKey.trim())}
                  disabled={!newOpenAIKey.trim() || updateOpenAIKey.isPending}
                  className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
                >
                  <Check size={14} /> Save
                </button>
                <button onClick={() => setEditingOpenAI(false)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-sm text-white font-mono">
                  {(company as { openai_api_key?: string | null }).openai_api_key
                    ? '••••••••••••' + ((company as { openai_api_key?: string }).openai_api_key ?? '').slice(-4)
                    : <span className="text-gray-500 italic font-sans">Not set</span>}
                </span>
                <button
                  onClick={() => setEditingOpenAI(true)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                >
                  <Pencil size={13} /> {(company as { openai_api_key?: string | null }).openai_api_key ? 'Rotate' : 'Set key'}
                </button>
              </div>
            )}
          </div>

          {/* Anthropic */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">Anthropic API key</label>
            {editingAnthropic ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  type="password"
                  value={newAnthropicKey}
                  onChange={(e) => setNewAnthropicKey(e.target.value)}
                  placeholder="sk-ant-..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newAnthropicKey.trim()) updateAnthropicKey.mutate(newAnthropicKey.trim())
                    if (e.key === 'Escape') setEditingAnthropic(false)
                  }}
                  className="flex-1 bg-gray-800 border border-purple-500 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none"
                />
                <button
                  onClick={() => newAnthropicKey.trim() && updateAnthropicKey.mutate(newAnthropicKey.trim())}
                  disabled={!newAnthropicKey.trim() || updateAnthropicKey.isPending}
                  className="flex items-center gap-1 px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm rounded-lg"
                >
                  <Check size={14} /> Save
                </button>
                <button onClick={() => setEditingAnthropic(false)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-sm text-white font-mono">
                  {(company as { anthropic_api_key?: string | null }).anthropic_api_key
                    ? '••••••••••••' + ((company as { anthropic_api_key?: string }).anthropic_api_key ?? '').slice(-4)
                    : <span className="text-gray-500 italic font-sans">Not set</span>}
                </span>
                <button
                  onClick={() => setEditingAnthropic(true)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                >
                  <Pencil size={13} /> {(company as { anthropic_api_key?: string | null }).anthropic_api_key ? 'Rotate' : 'Set key'}
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Agents shortcut */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white flex items-center gap-2">
                <Bot size={15} className="text-purple-400" /> Webhook agents
              </h2>
              <p className="text-gray-500 text-xs mt-1">Manage reusable external agents available across all projects.</p>
            </div>
            <button
              onClick={() => navigate('/company/agents')}
              className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg transition-colors"
            >
              <Bot size={13} /> Manage agents
            </button>
          </div>
        </section>

        {/* Delete */}
        <section className="bg-gray-900 border border-red-900/50 rounded-xl p-5">
          <h2 className="font-semibold text-red-400 mb-1 flex items-center gap-2">
            <Trash2 size={15} /> Delete company
          </h2>
          <p className="text-gray-500 text-sm mb-4">
            Permanently deletes the company, all its teams, memberships, and pending invites. This cannot be undone.
          </p>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 border border-red-800 rounded-lg hover:bg-red-900/30 transition-colors"
            >
              <Trash2 size={14} /> Delete company
            </button>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-red-300">Are you sure? This is permanent and cannot be undone.</p>
              <button
                onClick={() => deleteCompany.mutate()}
                disabled={deleteCompany.isPending}
                className="px-3 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {deleteCompany.isPending ? 'Deleting…' : 'Yes, delete everything'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </section>

      </div>
    </div>
  )
}
