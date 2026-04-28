import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Briefcase, Check } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import type { Skill } from '../types'
import toast from 'react-hot-toast'

export default function SelectSkillsModal() {
  const { session, setNeedsSkills } = useAuthStore()
  const userId = session?.user?.id ?? ''

  const { data: allSkills = [], isLoading } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: () => api.get<Skill[]>('/skills').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const categories = [...new Set(allSkills.map((s) => s.category))]
  const [selected, setSelected] = useState<string[]>([])

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )

  const save = useMutation({
    mutationFn: () =>
      api.put('/skills/user', { user_id: userId, skill_ids: selected }),
    onSuccess: () => {
      toast.success('Skills saved!')
      setNeedsSkills(false)
    },
    onError: () => toast.error('Failed to save skills'),
  })

  const handleSkip = () => setNeedsSkills(false)

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 mb-2 shrink-0">
          <div className="w-9 h-9 rounded-lg bg-purple-900/40 border border-purple-800/40 flex items-center justify-center shrink-0">
            <Briefcase size={16} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-white font-semibold leading-tight">What are your skills?</h2>
            <p className="text-gray-400 text-xs mt-0.5">
              Help your team know your specialisations. You can update these later in your profile.
            </p>
          </div>
        </div>

        {/* Skill grid */}
        <div className="flex-1 overflow-y-auto mt-4 pr-1 space-y-4">
          {isLoading ? (
            <p className="text-gray-500 text-sm">Loading skills…</p>
          ) : (
            categories.map((cat) => (
              <div key={cat}>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{cat}</p>
                <div className="flex flex-wrap gap-2">
                  {allSkills.filter((s) => s.category === cat).map((skill) => {
                    const on = selected.includes(skill.id)
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => toggle(skill.id)}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                          on
                            ? 'bg-purple-700 border-purple-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                        }`}
                      >
                        {skill.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-5 pt-4 border-t border-gray-800 shrink-0">
          <button
            type="button"
            onClick={handleSkip}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={selected.length === 0 || save.isPending}
            className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
          >
            {save.isPending ? 'Saving…' : <><Check size={14} /> Save skills</>}
          </button>
        </div>
      </div>
    </div>
  )
}
