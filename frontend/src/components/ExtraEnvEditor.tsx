import { Plus, Trash2 } from 'lucide-react'
import type { EnvPair } from '../lib/envUtils'
export type { EnvPair } from '../lib/envUtils'

export function ExtraEnvEditor({
  pairs,
  onChange,
  label = 'Extra env vars',
  hint = 'e.g. FIGMA_TOKEN',
}: {
  pairs: EnvPair[]
  onChange: (p: EnvPair[]) => void
  label?: string
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-gray-400">
        {label} <span className="text-gray-600">({hint})</span>
      </label>
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            value={p.key}
            onChange={(e) => {
              const n = [...pairs]
              n[i] = { ...n[i], key: e.target.value }
              onChange(n)
            }}
            placeholder="KEY"
            className="w-36 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          <input
            value={p.value}
            onChange={(e) => {
              const n = [...pairs]
              n[i] = { ...n[i], value: e.target.value, isMasked: false }
              onChange(n)
            }}
            placeholder={p.isMasked ? '(unchanged)' : 'value'}
            type="password"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            className="text-gray-600 hover:text-red-400"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-purple-400 transition-colors"
      >
        <Plus size={11} /> Add variable
      </button>
    </div>
  )
}
