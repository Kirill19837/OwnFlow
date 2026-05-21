import { X, Copy, Download, FileCode } from 'lucide-react'
import { useState } from 'react'
import toast from 'react-hot-toast'

interface FileEntry {
  path: string
  content: string
}

interface FileViewerModalProps {
  files: FileEntry[]
  isOpen: boolean
  onClose: () => void
  taskTitle?: string
}

export function FileViewerModal({ files, isOpen, onClose, taskTitle }: FileViewerModalProps) {
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  if (!isOpen || files.length === 0) return null

  const safeIndex = selectedFileIndex < files.length ? selectedFileIndex : 0
  const selectedFile = files[safeIndex]

  const copyToClipboard = () => {
    navigator.clipboard.writeText(selectedFile.content)
    toast.success('Copied to clipboard')
  }

  const downloadFile = () => {
    const element = document.createElement('a')
    const file = new Blob([selectedFile.content], { type: 'text/plain' })
    element.href = URL.createObjectURL(file)
    element.download = selectedFile.path.split('/').pop() || 'file.txt'
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
    toast.success('File downloaded')
  }

  const getLanguageBadge = (path: string) => {
    if (path.endsWith('.js')) return 'JavaScript'
    if (path.endsWith('.ts')) return 'TypeScript'
    if (path.endsWith('.tsx')) return 'TypeScript React'
    if (path.endsWith('.jsx')) return 'JavaScript React'
    if (path.endsWith('.py')) return 'Python'
    if (path.endsWith('.java')) return 'Java'
    if (path.endsWith('.go')) return 'Go'
    if (path.endsWith('.rs')) return 'Rust'
    if (path.endsWith('.cpp')) return 'C++'
    if (path.endsWith('.c')) return 'C'
    if (path.endsWith('.md')) return 'Markdown'
    if (path.endsWith('.json')) return 'JSON'
    if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'YAML'
    if (path.endsWith('.html')) return 'HTML'
    if (path.endsWith('.css')) return 'CSS'
    if (path.endsWith('.sql')) return 'SQL'
    return 'Text'
  }

  return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/70" onClick={onClose} />

        {/* Modal */}
        <div className="relative z-10 flex flex-col bg-gray-900 border border-gray-800 rounded-lg shadow-2xl max-w-4xl w-[90vw] h-[85vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
            <div className="flex items-center gap-3">
              <FileCode size={18} className="text-purple-400" />
              <div>
                <p className="text-sm text-gray-500 line-clamp-1">
                  {taskTitle ? `Task: ${taskTitle}` : 'Generated Files'}
                </p>
                <p className="text-base font-semibold text-white truncate">{selectedFile.path}</p>
              </div>
            </div>
            <button
                onClick={onClose}
                aria-label="Close"
                className="text-gray-500 hover:text-white transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* File List Sidebar */}
            <div className="w-64 border-r border-gray-800 overflow-y-auto bg-gray-950/50 shrink-0">
              <div className="p-2 space-y-1">
                {files.map((file, idx) => (
                    <button
                        key={idx}
                        onClick={() => setSelectedFileIndex(idx)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-colors ${
                            idx === safeIndex
                                ? 'bg-purple-900/40 text-purple-300 border border-purple-700/50'
                                : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800/30'
                        }`}
                        title={file.path}
                    >
                      <div className="truncate">{file.path}</div>
                    </button>
                ))}
              </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Language badge + actions */}
              <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-gray-900/50 shrink-0">
              <span className="text-xs font-medium text-gray-400 bg-gray-800 px-2.5 py-1 rounded">
                {getLanguageBadge(selectedFile.path)}
              </span>
                <div className="flex items-center gap-2">
                  <button
                      onClick={copyToClipboard}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
                      title="Copy to clipboard"
                  >
                    <Copy size={13} />
                    Copy
                  </button>
                  <button
                      onClick={downloadFile}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-purple-900/30 hover:bg-purple-800/40 text-purple-300 hover:text-purple-200 transition-colors border border-purple-700/30"
                      title="Download file"
                  >
                    <Download size={13} />
                    Download
                  </button>
                </div>
              </div>

              {/* Code Content */}
              <div className="flex-1 overflow-auto p-6 min-w-0">
              <pre className="font-mono text-xs leading-relaxed text-gray-300 whitespace-pre-wrap break-words">
                <code>{selectedFile.content}</code>
              </pre>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-gray-800 bg-gray-950/50 text-xs text-gray-500 shrink-0">
            Showing {safeIndex + 1} of {files.length} file{files.length !== 1 ? 's' : ''} • {selectedFile.content.length.toLocaleString()} characters
          </div>
        </div>
      </div>
  )
}
