import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import type { Skill, TeamMember } from '../types'
import { Trash2, Bot, User, ChevronLeft, ChevronDown, ChevronUp, Zap } from 'lucide-react'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
  { value: 'o3-mini', label: 'o3-mini', provider: 'OpenAI' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', provider: 'Anthropic' },
]

/** Pool of names randomly assigned to AI actors */
const AI_NAMES = [
  'Aria', 'Nova', 'Orion', 'Sage', 'Atlas', 'Echo', 'Lyra', 'Zara',
  'Cleo', 'Finn', 'Mira', 'Denis', 'Skye', 'Theo', 'Wren', 'Zion',
  'Axel', 'Cara', 'Dex', 'Iris', 'Juno', 'Kael', 'Lena', 'Max',
]

let _usedNames: string[] = []
const pickAIName = () => {
  const pool = AI_NAMES.filter((n) => !_usedNames.includes(n))
  if (pool.length === 0) _usedNames = []
  const pick = (pool.length ? pool : AI_NAMES)[Math.floor(Math.random() * (pool.length || AI_NAMES.length))]
  _usedNames.push(pick)
  return pick
}

/** Names used for auto-fill (in order) */
const AUTO_FILL_NAMES = [
  'AI Project Manager', 'Architect', 'Lead Developer',
  'Frontend Developer', 'Backend Developer', 'QA Automation Lead',
  'Product Owner', 'UI/UX Designer',
]

interface ActorDraft {
  role: string        // skill name, e.g. "Lead Developer"
  name: string        // display name (auto-filled from member or AI name)
  type: 'human' | 'ai'
  model: string
  characteristics: string
  user_id?: string    // links human actor to a real team member
}

const orderActors = (items: ActorDraft[]) => {
  const humans = items.filter((a) => a.type === 'human')
  const ai = items.filter((a) => a.type === 'ai')
  return [...humans, ...ai]
}

export default function NewProjectPage() {
  const { session } = useAuthStore()
  const { activeTeam } = useTeamStore()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [aiModel, setAiModel] = useState(activeTeam?.default_ai_model ?? 'gpt-4o')
  const [sprintDays, setSprintDays] = useState(3)
  const defaultActorModel = activeTeam?.default_ai_model ?? 'gpt-4o'

  // Fetch team members to use as human actor options
  const { data: teamData, isLoading: teamMembersLoading } = useQuery({
    queryKey: ['team', activeTeam?.id],
    queryFn: () => api.get<{ members?: TeamMember[] }>(`/teams/${activeTeam!.id}`).then((r) => r.data),
    enabled: !!activeTeam?.id && !!session?.access_token,
  })
  const teamMembers: TeamMember[] = useMemo(() => teamData?.members ?? [], [teamData?.members])

  // Fetch each member's declared skills so they can be shown in the picker.
  const memberSkillQueries = useQueries({
    queries: teamMembers.map((m) => ({
      queryKey: ['skills', 'user', m.user_id],
      queryFn: () => api.get<Skill[]>(`/skills/user/${m.user_id}`).then((r) => r.data),
      enabled: !!session?.access_token,
      staleTime: 5 * 60 * 1000,
    })),
  })
  const memberSkillsByUserId: Record<string, Skill[]> = {}
  const memberSkillsLoadingByUserId: Record<string, boolean> = {}
  teamMembers.forEach((m, i) => {
    memberSkillsByUserId[m.user_id] = memberSkillQueries[i]?.data ?? []
    memberSkillsLoadingByUserId[m.user_id] = !!memberSkillQueries[i]?.isLoading
  })

  // Fetch skills from DB
  const { data: skills = [] } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: () => api.get<Skill[]>('/skills').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })
  const roleCategories = useMemo(() => [...new Set(skills.map((s) => s.category))], [skills])

  const seededRef = useRef(false)
  const [actors, setActors] = useState<ActorDraft[]>([])
  // Seed default actors once per page load.
  useEffect(() => {
    if (seededRef.current || !session?.user.id) return
    seededRef.current = true
    _usedNames = []
    const pm = skills.find((s) => s.name === 'AI Project Manager')
    // Creator is always the first human actor, linked to their user account
    const myMember = teamMembers.find((m) => m.user_id === session?.user.id)
    const myName = myMember?.full_name || session?.user.user_metadata?.full_name || session?.user.email || 'You'
    setActors(orderActors([
      { role: pm?.name ?? 'AI Project Manager', name: pickAIName(), type: 'ai',    model: defaultActorModel, characteristics: pm?.description ?? '' },
      { role: 'Project Lead', name: myName, type: 'human', model: '', characteristics: '', user_id: session?.user.id },
    ]))
  }, [skills, defaultActorModel, session?.user.id, session?.user.email, session?.user.user_metadata?.full_name, teamMembers])
  // seededRef.current guard ensures this only runs once; full deps listed for exhaustive-deps rule

  const [showRolePicker, setShowRolePicker] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [planning, setPlanningState] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [assistantRequest, setAssistantRequest] = useState('')
  const [assistantSuggestion, setAssistantSuggestion] = useState<{ name: string; prompt: string; notes?: string } | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const createProject = useMutation({
    mutationFn: async () => {
      const { data: project } = await api.post('/projects', {
        name,
        prompt,
        owner_id: session!.user.id,
        team_id: activeTeam?.id ?? null,
        ai_model: aiModel,
        sprint_days: sprintDays,
        auto_plan: false,
      })
      await Promise.all(
        actors.map((a) =>
          api.post(`/projects/${project.id}/actors`, {
            project_id: project.id,
            name: a.name || a.role,
            role: a.role,
            type: a.type,
            model: a.type === 'ai' ? a.model : undefined,
            characteristics: a.characteristics || undefined,
            capabilities: [],
            user_id: a.user_id ?? null,
          })
        )
      )
      return project
    },
    onSuccess: (project) => {
      setPlanningState(true)
      setPlanError(null)
      setLogs(['🚀 Project created. Starting plan generation…'])
      const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const es = new EventSource(`${apiBase}/projects/${project.id}/plan/stream?ai_model=${encodeURIComponent(aiModel)}`)
      esRef.current = es
      es.onmessage = (e) => {
        const payload = JSON.parse(e.data)
        if (payload.type === 'log') {
          setLogs((prev) => [...prev, payload.message])
        } else if (payload.type === 'done') {
          es.close()
          setLogs((prev) => [...prev, '🏁 Done! Redirecting…'])
          setTimeout(() => navigate(`/projects/${project.id}`), 900)
        } else if (payload.type === 'error') {
          setPlanError(payload.message)
          setLogs((prev) => [...prev, `❌ Error: ${payload.message}`])
          es.close()
        }
      }
      es.onerror = () => {
        setPlanError('Connection lost.')
        setLogs((prev) => [...prev, '❌ Connection to server lost.'])
        es.close()
      }
    },
  })

  const assistProject = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ name: string; prompt: string; notes?: string }>('/projects/assist', {
        name,
        prompt,
        request: assistantRequest,
        ai_model: aiModel,
      })
      return data
    },
    onSuccess: (data) => setAssistantSuggestion(data),
  })

  const autoFill = () => {
    _usedNames = []
    const preservedHumans = actors.filter((a) => a.type === 'human')
    const autoAiActors = AUTO_FILL_NAMES.flatMap((roleName) => {
        const skill = skills.find((s) => s.name === roleName)
        if (!skill) return []
        const type: 'human' | 'ai' = skill.actor_type === 'human' ? 'human' : 'ai'
        if (type === 'human') return []
        return [{
          role: roleName,
          name: type === 'ai' ? pickAIName() : '',
          type,
          model: type === 'ai' ? defaultActorModel : '',
          characteristics: skill.description ?? '',
          user_id: undefined,
        }]
      })
    setActors(orderActors([...preservedHumans, ...autoAiActors]))
    setShowRolePicker(false)
  }

  const addFromTemplate = (skill: Skill, typeOverride?: 'human' | 'ai') => {
    const type = typeOverride ?? (skill.actor_type === 'both' ? 'ai' : skill.actor_type as 'human' | 'ai')
    setActors((prev) => [
      ...orderActors(prev),
      { role: skill.name, name: type === 'ai' ? pickAIName() : '', type, model: type === 'ai' ? defaultActorModel : '', characteristics: skill.description ?? '', user_id: undefined },
    ])
  }

  const addHumanTeammate = () => {
    setActors((prev) => orderActors([
      ...prev,
      { role: 'Team Member', name: '', type: 'human', model: '', characteristics: '', user_id: undefined },
    ]))
  }

  const removeActor = (i: number) => setActors((prev) => prev.filter((_, idx) => idx !== i))

  const updateActor = (i: number, patch: Partial<ActorDraft>) =>
    setActors((prev) => orderActors(prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a))))

  return (
    <div className="max-w-2xl mx-auto w-full px-6 py-10">
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
      >
        <ChevronLeft size={16} /> Back
      </button>
      <h1 className="text-2xl font-bold text-white mb-2">New Project</h1>
      <p className="text-gray-400 text-sm mb-8">
        Describe what you want to build — AI will break it into tasks and sprints.
      </p>

      <div className="space-y-6">
        {/* Project name */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Project name</label>
          <input
            type="text"
            required
            placeholder="e.g. E-commerce checkout revamp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Project description / prompt
          </label>
          <textarea
            required
            rows={7}
            placeholder="Describe the product, goals, tech stack, constraints, and any specific requirements. Be as detailed as you want — the AI will use this to generate the full task breakdown."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
          />
        </div>

        {/* AI assistant */}
        <div className="bg-gray-900/70 border border-purple-900/60 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-purple-300">AI Assistant</p>
            <span className="text-[11px] text-gray-500">Use it to draft or improve your project brief</span>
          </div>
          <textarea
            rows={2}
            value={assistantRequest}
            onChange={(e) => setAssistantRequest(e.target.value)}
            placeholder="Example: Help me turn this into a detailed project brief with scope and acceptance criteria"
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => assistProject.mutate()}
              disabled={assistProject.isPending || (!assistantRequest.trim() && !prompt.trim())}
              className="text-xs px-2.5 py-1 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white transition-colors"
            >
              {assistProject.isPending ? 'Thinking…' : 'Ask AI assistant'}
            </button>
            {assistProject.isError && (
              <span className="text-xs text-red-400">{(assistProject.error as Error)?.message}</span>
            )}
          </div>
          {assistantSuggestion && (
            <div className="mt-2 bg-gray-950 border border-gray-700 rounded-lg p-3 space-y-2">
              <div>
                <p className="text-[11px] text-gray-500 uppercase tracking-wide">Suggested project name</p>
                <p className="text-sm text-white">{assistantSuggestion.name}</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-500 uppercase tracking-wide">Suggested brief</p>
                <p className="text-xs text-gray-300 whitespace-pre-wrap">{assistantSuggestion.prompt}</p>
              </div>
              {assistantSuggestion.notes && (
                <p className="text-xs text-purple-300">{assistantSuggestion.notes}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setName(assistantSuggestion.name)
                    setPrompt(assistantSuggestion.prompt)
                  }}
                  className="text-xs px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors"
                >
                  Apply suggestion
                </button>
                <button
                  type="button"
                  onClick={() => setAssistantSuggestion(null)}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Actors */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="block text-sm font-medium text-gray-300">Team (actors)</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={addHumanTeammate}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-blue-900/40 text-blue-300 hover:bg-blue-900/70 transition-colors"
              >
                <User size={11} /> Add teammate
              </button>
              <button
                type="button"
                onClick={autoFill}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-purple-900/40 text-purple-300 hover:bg-purple-900/70 transition-colors"
              >
                <Zap size={11} /> Auto-fill
              </button>
              <button
                type="button"
                onClick={() => setShowRolePicker((v) => !v)}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
              >
                {showRolePicker ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                Add role
              </button>
            </div>
          </div>

          {/* Role picker */}
          {showRolePicker && (
            <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-3">
              {skills.length === 0 && <p className="text-xs text-gray-500">Loading skills…</p>}
              {roleCategories.map((cat) => (
                <div key={cat}>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">{cat}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {skills.filter((s) => s.category === cat).map((skill) => {
                      const hasAI    = actors.some((a) => a.role === skill.name && a.type === 'ai')
                      const hasHuman = actors.some((a) => a.role === skill.name && a.type === 'human')

                      if (skill.actor_type === 'both') {
                        return (
                          <span key={skill.name} className="inline-flex rounded-md overflow-hidden border border-gray-700 text-xs">
                            <button
                              type="button"
                              title={`Add ${skill.name} (AI)`}
                              disabled={hasAI}
                              onClick={() => addFromTemplate(skill, 'ai')}
                              className={`flex items-center gap-1 px-2 py-1 transition-colors ${
                                hasAI ? 'text-gray-600 cursor-default' : 'text-purple-300 hover:bg-purple-900/40'
                              }`}
                            >
                              <Bot size={10} />{skill.name}{hasAI && <span className="text-gray-600">✓</span>}
                            </button>
                            <span className="w-px bg-gray-700" />
                            <button
                              type="button"
                              title={`Add ${skill.name} (Human)`}
                              disabled={hasHuman}
                              onClick={() => addFromTemplate(skill, 'human')}
                              className={`flex items-center gap-1 px-1.5 py-1 transition-colors ${
                                hasHuman ? 'text-gray-600 cursor-default' : 'text-blue-300 hover:bg-blue-900/40'
                              }`}
                            >
                              <User size={10} />{hasHuman && <span className="text-gray-600">✓</span>}
                            </button>
                          </span>
                        )
                      }

                      const already = skill.actor_type === 'ai' ? hasAI : hasHuman
                      return (
                        <button
                          key={skill.name}
                          type="button"
                          disabled={already}
                          onClick={() => addFromTemplate(skill)}
                          className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors ${
                            already
                              ? 'border-gray-700 text-gray-600 cursor-default'
                              : skill.actor_type === 'ai'
                              ? 'border-purple-700/60 text-purple-300 hover:bg-purple-900/40'
                              : 'border-blue-700/60 text-blue-300 hover:bg-blue-900/40'
                          }`}
                        >
                          {skill.actor_type === 'ai' ? <Bot size={10} /> : <User size={10} />}
                          {skill.name}
                          {already && <span className="text-gray-600 ml-0.5">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {actors.map((actor, i) => (
              <div
                key={i}
                className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 space-y-1.5"
              >
                {/* Top row: icon, role label, type toggle, model, delete */}
                <div className="flex items-center gap-2">
                  {actor.type === 'ai' ? (
                    <Bot size={15} className="text-purple-400 shrink-0" />
                  ) : (
                    <User size={15} className="text-blue-400 shrink-0" />
                  )}
                  <span className="text-xs text-gray-500 shrink-0">{actor.role}</span>
                  <div className="flex-1" />
                  {/* AI / Human toggle */}
                  <div className="flex rounded overflow-hidden border border-gray-700 text-xs shrink-0">
                    <button
                      type="button"
                      onClick={() => updateActor(i, { type: 'ai', model: defaultActorModel, name: actor.name || pickAIName(), user_id: undefined })}
                      className={`flex items-center gap-0.5 px-2 py-0.5 transition-colors ${
                        actor.type === 'ai' ? 'bg-purple-900 text-purple-300' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <Bot size={10} /> AI
                    </button>
                    <button
                      type="button"
                      onClick={() => updateActor(i, { type: 'human', model: '', name: '', user_id: undefined })}
                      className={`flex items-center gap-0.5 px-2 py-0.5 transition-colors ${
                        actor.type === 'human' ? 'bg-blue-900 text-blue-300' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <User size={10} /> Human
                    </button>
                  </div>
                  {actor.type === 'ai' && (
                    <select
                      value={actor.model}
                      onChange={(e) => updateActor(i, { model: e.target.value })}
                      className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none"
                    >
                      {AI_MODELS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => removeActor(i)}
                    className="text-gray-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {/* Name row */}
                {actor.type === 'ai' ? (
                  <input
                    type="text"
                    value={actor.name}
                    onChange={(e) => updateActor(i, { name: e.target.value })}
                    placeholder="AI agent name"
                    className="w-full bg-transparent text-white text-sm font-medium focus:outline-none pl-6 border-t border-gray-800 pt-1.5"
                  />
                ) : (
                  <div className="pl-6 border-t border-gray-800 pt-1.5">
                    <select
                      value={actor.user_id ?? ''}
                      disabled={teamMembersLoading}
                      onChange={(e) => {
                        const uid = e.target.value
                        if (!uid) {
                          updateActor(i, { user_id: undefined, name: '' })
                        } else {
                          const m = teamMembers.find((m) => m.user_id === uid)
                          updateActor(i, { user_id: uid, name: m?.full_name || m?.email || uid })
                        }
                      }}
                      className="w-full bg-transparent text-white text-sm font-medium focus:outline-none focus:text-purple-300 appearance-none"
                    >
                      <option value="" className="bg-gray-900 text-gray-400">— unassigned —</option>
                      {actor.user_id && !teamMembers.some((m) => m.user_id === actor.user_id) && (
                        <option value={actor.user_id} className="bg-gray-900 text-gray-300">
                          {actor.name || 'Current user'}
                        </option>
                      )}
                      {teamMembersLoading && (
                        <option value="" disabled className="bg-gray-900 text-gray-500">Loading team members…</option>
                      )}
                      {!teamMembersLoading && teamMembers.length === 0 && (
                        <option value="" disabled className="bg-gray-900 text-gray-500">No team members found</option>
                      )}
                      {teamMembers.map((m) => {
                        const label = m.full_name || m.email || m.user_id
                        const memberSkills = memberSkillsByUserId[m.user_id] ?? []
                        const memberSkillPreview = memberSkills.map((s) => s.name).slice(0, 3).join(', ')
                        const alreadyUsed = actors.some((a, idx) => idx !== i && a.user_id === m.user_id)
                        return (
                          <option key={m.user_id} value={m.user_id} disabled={alreadyUsed} className="bg-gray-900">
                            {label}
                            {memberSkillPreview ? ` · ${memberSkillPreview}` : ''}
                            {memberSkills.length > 3 ? ` +${memberSkills.length - 3}` : ''}
                            {alreadyUsed ? ' (added)' : ''}
                          </option>
                        )
                      })}
                    </select>
                    {actor.user_id && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {memberSkillsLoadingByUserId[actor.user_id] ? (
                          <span className="text-[11px] text-gray-500">Loading skills…</span>
                        ) : (memberSkillsByUserId[actor.user_id] ?? []).length > 0 ? (
                          (memberSkillsByUserId[actor.user_id] ?? []).map((skill) => (
                            <span key={skill.id} className="text-[11px] px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-800/40">
                              {skill.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-gray-500">No skills specified</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {/* Characteristics row */}
                <input
                  type="text"
                  value={actor.characteristics}
                  onChange={(e) => updateActor(i, { characteristics: e.target.value })}
                  placeholder="Role focus & characteristics…"
                  className="w-full bg-transparent text-gray-400 text-xs focus:outline-none pl-6 border-t border-gray-800 pt-1.5 focus:text-gray-200 transition-colors"
                />
              </div>
            ))}
          </div>
        </div>

        {/* AI Model override */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">AI model for this project</label>
          <p className="text-xs text-gray-500 mb-2">
            Team default: <span className="text-purple-400">{activeTeam?.default_ai_model ?? 'gpt-4o'}</span>. Override below if needed.
          </p>
          <select
            value={aiModel}
            onChange={(e) => setAiModel(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            {AI_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label} ({m.provider})</option>
            ))}
          </select>
        </div>

        {/* Sprint length */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Sprint length</label>
          <p className="text-xs text-gray-500 mb-2">
            How many calendar days per sprint. Affects task capacity (8 h/day).
          </p>
          <div className="flex gap-2 flex-wrap">
            {[1, 2, 3, 5, 7, 10, 14].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setSprintDays(d)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  sprintDays === d
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {d}d
              </button>
            ))}
            <span className="text-xs text-gray-500 self-center ml-1">
              {sprintDays} day{sprintDays !== 1 ? 's' : ''} · {sprintDays * 8}h capacity
            </span>
          </div>
        </div>

        {createProject.isError && (
          <p className="text-red-400 text-sm">{(createProject.error as Error)?.message}</p>
        )}

        <button
          onClick={() => createProject.mutate()}
          disabled={createProject.isPending || planning || !name || !prompt}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors"
        >
          {createProject.isPending ? 'Creating project…' : '✨ Create Project & Generate Plan'}
        </button>
      </div>

      {/* Planning log panel */}
      {planning && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end justify-center z-50 p-4">
          <div className="w-full max-w-2xl bg-gray-950 border border-gray-700 rounded-xl shadow-2xl flex flex-col" style={{maxHeight: '70vh'}}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <span className="text-sm font-mono font-semibold text-purple-300">AI Planning Log</span>
              {planError && (
                <button
                  onClick={() => setPlanningState(false)}
                  className="text-xs text-gray-500 hover:text-gray-300"
                >
                  Close
                </button>
              )}
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 font-mono text-xs space-y-1">
              {logs.map((line, i) => (
                <div key={i} className="text-gray-300 leading-relaxed">
                  <span className="text-gray-600 mr-2 select-none">{String(i + 1).padStart(2, '0')}</span>
                  {line}
                </div>
              ))}
              {!planError && logs.length > 0 && logs[logs.length - 1] !== '🏁 Done! Redirecting…' && (
                <div className="flex items-center gap-1.5 text-gray-500">
                  <span className="animate-pulse">●</span> Working…
                </div>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
