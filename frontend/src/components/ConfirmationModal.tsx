import { AlertCircle, X } from 'lucide-react'
import type { ConfirmationState } from '../hooks/useConfirmation'

interface ConfirmationModalProps {
  confirmation: ConfirmationState | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmationModal({ confirmation, onConfirm, onCancel }: ConfirmationModalProps) {
  if (!confirmation) return null

  const {
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isDangerous = false,
  } = confirmation

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-800 rounded-lg shadow-xl max-w-sm w-full">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-gray-800">
          <div className="flex items-start gap-3">
            {isDangerous && <AlertCircle size={20} className="text-red-400 flex-shrink-0 mt-0.5" />}
            <h2 className="text-lg font-semibold text-white">{title}</h2>
          </div>
          <button
            onClick={onCancel}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          <div className="text-gray-300">
            {typeof message === 'string' ? <p>{message}</p> : message}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-800 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors font-medium"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              isDangerous
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-purple-600 hover:bg-purple-700 text-white'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

