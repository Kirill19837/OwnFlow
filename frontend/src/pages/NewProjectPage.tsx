import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useTeamStore } from '../store/teamStore'
import api from '../lib/api'
import { Trash2, Bot, User, ChevronLeft, ChevronDown, ChevronUp, Zap } from 'lucide-react'

const AI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
  { value: 'o3-mini', label: 'o3-mini', provider: 'OpenAI' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', provider: 'Anthropic' },
]

interface RoleTemplate {
  name: string
  /** 'both' = can be added as either AI or Human */
  type: 'human' | 'ai' | 'both'
  category: string
  characteristics: string
}

const ROLE_TEMPLATES: RoleTemplate[] = [
  // Engineering — all 'both' so you can add human devs too
  { name: 'Lead Developer',     type: 'both',  category: 'Engineering', characteristics: 'Drives technical decisions, reviews PRs, and mentors the team on best practices.' },
  { name: 'Senior Developer',   type: 'both',  category: 'Engineering', characteristics: 'Implements core features and complex business logic with high code quality.' },
  { name: 'Backend Developer',  type: 'both',  category: 'Engineering', characteristics: 'Designs APIs, schemas, and services. Focused on performance and reliability.' },
  { name: 'Frontend Developer', type: 'both',  category: 'Engineering', characteristics: 'Builds responsive, accessible UIs. Manages component state and integrations.' },
  { name: 'Architect',          type: 'both',  category: 'Engineering', characteristics: 'Defines system design, tech stack choices, and scalability patterns.' },
  { name: 'DevOps Engineer',    type: 'both',  category: 'Engineering', characteristics: 'Manages CI/CD, infrastructure-as-code, monitoring, and release automation.' },
  // Quality
  { name: 'QA Automation Lead', type: 'both',  category: 'Quality', characteristics: 'Designs and maintains automated test suites; owns coverage and regression strategy.' },
  { name: 'QA Manual',          type: 'human', category: 'Quality', characteristics: 'Runs exploratory and acceptance testing; documents bugs with full reproduction steps.' },
  { name: 'Security Reviewer',  type: 'both',  category: 'Quality', characteristics: 'Audits code for OWASP vulnerabilities and enforces secure coding standards.' },
  // Product
  { name: 'Product Owner',      type: 'human', category: 'Product', characteristics: 'Owns the backlog, defines acceptance criteria, and represents the customer.' },
  { name: 'Business Analyst',   type: 'both',  category: 'Product', characteristics: 'Maps requirements to specs, validates scope, and bridges business and tech.' },
  { name: 'UI/UX Designer',     type: 'both',  category: 'Product', characteristics: 'Creates wireframes, design systems, and user flows that prioritise usability.' },
  { name: 'Copywriter',         type: 'both',  category: 'Product', characteristics: 'Writes product copy, tooltips, onboarding text, and user-facing documentation.' },
  // Management
  { name: 'AI Project Manager', type: 'both',  category: 'Management', characteristics: 'Plans sprints, assigns tasks to actors, tracks progress, and surfaces blockers.' },
  { name: 'Scrum Master',       type: 'human', category: 'Management', characteristics: 'Facilitates stand-ups, retrospectives, and sprint ceremonies; removes impediments.' },
  // Feedback
  { name: 'Beta User',          type: 'human', category: 'Feedback', characteristics: 'Stress-tests the product as a real user and reports friction points and bugs.' },
  { name: 'Stakeholder',        type: 'human', category: 'Feedback', characteristics: 'Approves major decisions, aligns product direction, and reviews key deliverables.' },
]

const ROLE_CATEGORIES = ['Engineering', 'Quality', 'Product', 'Management', 'Feedback']

/** Pool of names randomly assigned to AI actors */
const AI_NAMES = [
  'Aria', 'Nova', 'Orion', 'Sage', 'Atlas', 'Echo', 'Lyra', 'Zara',
  'Cleo', 'Finn', 'Mira', 'Remy', 'Skye', 'Theo', 'Wren', 'Zion',
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

/** Default team used by Auto-fill */
const AUTO_FILL_ROLES: { name: string; type: 'human' | 'ai' }[] = [
  { name: 'AI Project Manager', type: 'ai' },
  { name: 'Architect',          type: 'ai' },
  { name: 'Lead Developer',     type: 'ai' },
  { name: 'Frontend Developer', type: 'ai' },
  { name: 'Backend Developer',  type: 'ai' },
  { name: 'QA Automation Lead', type: 'ai' },
  { name: 'Product Owner',      type: 'human' },
  { name: 'UI/UX Designer',     type: 'ai' },
]

interface ActorDraft {
  role: string        // template role name, e.g. "Lead Developer"
  name: string        // personal name, e.g. "Aria" (AI) or "" (human)
  type: 'human' | 'ai'
  model: string
  characteristics: string
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
  const [actors, setActors] = useState<ActorDraft[]>(() => {
    _usedNames = []
    const pm = ROLE_TEMPLATES.find((r) => r.name === 'AI Project Manager')!
    const po = ROLE_TEMPLATES.find((r) => r.name === 'Product Owner')!
    return [
      { role: pm.name, name: pickAIName(), type: 'ai',    model: defaultActorModel, characteristics: pm.characteristics },
      { role: po.name, name: '',            type: 'human', model: '',               characteristics: po.characteristics },
    ]
  })
  const [showRolePicker, setShowRolePicker] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [planning, setPlanningState] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
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

  const autoFill = () => {
    _usedNames = []
    setActors(
      AUTO_FILL_ROLES.map(({ name: roleName, type }) => {
        const tpl = ROLE_TEMPLATES.find((r) => r.name === roleName)
        return {
          role: roleName,
          name: type === 'ai' ? pickAIName() : '',
          type,
          model: type === 'ai' ? defaultActorModel : '',
          characteristics: tpl?.characteristics ?? '',
        }
      })
    )
    setShowRolePicker(false)
  }

  const addFromTemplate = (tpl: RoleTemplate, typeOverride?: 'human' | 'ai') => {
    const type = typeOverride ?? (tpl.type === 'both' ? 'ai' : tpl.type as 'human' | 'ai')
    setActors((prev) => [
      ...prev,
      { role: tpl.name, name: type === 'ai' ? pickAIName() : '', type, model: type === 'ai' ? defaultActorModel : '', characteristics: tpl.characteristics },
    ])
  }

  const removeActor = (i: number) => setActors((prev) => prev.filter((_, idx) => idx !== i))

  const updateActor = (i: number, patch: Partial<ActorDraft>) =>
    setActors((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))

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

        {/* Actors */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="block text-sm font-medium text-gray-300">Team (actors)</label>
            <div className="flex gap-2">
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
              {ROLE_CATEGORIES.map((cat) => (
                <div key={cat}>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">{cat}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {ROLE_TEMPLATES.filter((r) => r.category === cat).map((tpl) => {
                      const hasAI    = actors.some((a) => a.name === tpl.name && a.type === 'ai')
                      const hasHuman = actors.some((a) => a.name === tpl.name && a.type === 'human')

                      if (tpl.type === 'both') {
                        return (
                          <span key={tpl.name} className="inline-flex rounded-md overflow-hidden border border-gray-700 text-xs">
                            <button
                              type="button"
                              title={`Add ${tpl.name} (AI)`}
                              disabled={hasAI}
                              onClick={() => addFromTemplate(tpl, 'ai')}
                              className={`flex items-center gap-1 px-2 py-1 transition-colors ${
                                hasAI ? 'text-gray-600 cursor-default' : 'text-purple-300 hover:bg-purple-900/40'
                              }`}
                            >
                              <Bot size={10} />{tpl.name}{hasAI && <span className="text-gray-600">✓</span>}
                            </button>
                            <span className="w-px bg-gray-700" />
                            <button
                              type="button"
                              title={`Add ${tpl.name} (Human)`}
                              disabled={hasHuman}
                              onClick={() => addFromTemplate(tpl, 'human')}
                              className={`flex items-center gap-1 px-1.5 py-1 transition-colors ${
                                hasHuman ? 'text-gray-600 cursor-default' : 'text-blue-300 hover:bg-blue-900/40'
                              }`}
                            >
                              <User size={10} />{hasHuman && <span className="text-gray-600">✓</span>}
                            </button>
                          </span>
                        )
                      }

                      const already = tpl.type === 'ai' ? hasAI : hasHuman
                      return (
                        <button
                          key={tpl.name}
                          type="button"
                          disabled={already}
                          onClick={() => addFromTemplate(tpl)}
                          className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors ${
                            already
                              ? 'border-gray-700 text-gray-600 cursor-default'
                              : tpl.type === 'ai'
                              ? 'border-purple-700/60 text-purple-300 hover:bg-purple-900/40'
                              : 'border-blue-700/60 text-blue-300 hover:bg-blue-900/40'
                          }`}
                        >
                          {tpl.type === 'ai' ? <Bot size={10} /> : <User size={10} />}
                          {tpl.name}
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
                      onClick={() => updateActor(i, { type: 'ai', model: defaultActorModel, name: actor.name || pickAIName() })}
                      className={`flex items-center gap-0.5 px-2 py-0.5 transition-colors ${
                        actor.type === 'ai' ? 'bg-purple-900 text-purple-300' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <Bot size={10} /> AI
                    </button>
                    <button
                      type="button"
                      onClick={() => updateActor(i, { type: 'human', model: '' })}
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
                <input
                  type="text"
                  value={actor.name}
                  onChange={(e) => updateActor(i, { name: e.target.value })}
                  placeholder={actor.type === 'human' ? 'Your name (optional)' : 'AI agent name'}
                  className="w-full bg-transparent text-white text-sm font-medium focus:outline-none pl-6 border-t border-gray-800 pt-1.5"
                />
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
