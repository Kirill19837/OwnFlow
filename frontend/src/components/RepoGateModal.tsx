import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import toast from 'react-hot-toast'

interface Props {
  githubTokenAvailable?: boolean
  githubRepos?: { full_name: string; private: boolean }[]
  onRepoSet?: (repo: string) => void
  onExecuteWithout: () => void
  onCancel: () => void
}

export default function RepoGateModal({ githubTokenAvailable, githubRepos, onRepoSet, onExecuteWithout, onCancel }: Props) {
  const [repoInput, setRepoInput] = useState('')

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <GitBranch size={16} className="text-yellow-400" />
          <h3 className="text-white font-semibold text-sm">No GitHub repo selected</h3>
        </div>
        <p className="text-xs text-gray-400">
          The agent can execute, but no Pull Request will be created without a connected repository.
        </p>

        {githubTokenAvailable && githubRepos && githubRepos.length > 0 ? (
          <div className="space-y-2">
            <label className="block text-xs text-gray-400">Pick a repo for this project</label>
            <div className="flex gap-2">
              <input
                placeholder="Search repository…"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                list="gate-repo-options"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <datalist id="gate-repo-options">
                {githubRepos.map((r) => (
                  <option key={r.full_name} value={r.full_name}>
                    {r.private ? 'private' : 'public'}
                  </option>
                ))}
              </datalist>
              <button
                onClick={() => {
                  const r = repoInput.trim()
                  if (r && onRepoSet) {
                    onRepoSet(r)
                    toast.success(`Repo set to ${r}`)
                    setTimeout(() => onExecuteWithout(), 500)
                  }
                }}
                disabled={!repoInput.trim()}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
              >
                Connect &amp; Execute
              </button>
            </div>
          </div>
        ) : githubTokenAvailable ? (
          <p className="text-xs text-gray-500 italic">Loading repositories…</p>
        ) : (
          <p className="text-xs text-gray-500">Connect GitHub in project settings first.</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onExecuteWithout}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
          >
            Execute without repo
          </button>
        </div>
      </div>
    </div>
  )
}
