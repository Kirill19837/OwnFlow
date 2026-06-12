import { useNavigate } from 'react-router-dom'
import { Zap, Rocket, Star, X, ArrowRight } from 'lucide-react'
import { PLAN_LABELS } from '../lib/planLimits'

interface Props {
  used?: number
  limit?: number
  onClose: () => void
}

export default function AiLimitModal({ used, limit, onClose }: Props) {
  const navigate = useNavigate()

  const handleUpgrade = () => {
    onClose()
    navigate('/company/settings')
  }

  return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
        />

        {/* Added role="dialog", aria-modal and aria-labelledby for screen readers */}
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-limit-modal-title"
            className="relative w-full max-w-md bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden"
        >

          <div className="px-6 pt-5 pb-6">
            {/* aria-label gives screen readers an accessible name for the close button */}
            <button
                onClick={onClose}
                aria-label="Close"
                className="absolute top-4 right-4 text-gray-600 hover:text-gray-300 transition-colors"
            >
              <X size={18} />
            </button>

            {/* Icon + heading */}
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-900/40 border border-amber-700/50 flex items-center justify-center shrink-0">
                <Zap size={18} className="text-amber-400" />
              </div>
              <div>
                {/* id matches aria-labelledby on the dialog container */}
                <h2 id="ai-limit-modal-title" className="text-white font-semibold text-lg leading-tight">
                  AI request limit reached
                </h2>
                {used !== undefined && limit !== undefined && (
                    <p className="text-gray-500 text-sm mt-0.5">
                      {used} / {limit} requests used this month
                    </p>
                )}
              </div>
            </div>

            {/* Progress bar */}
            {used !== undefined && limit !== undefined && (
                <div className="w-full bg-gray-800 rounded-full h-1.5 mb-5">
                  <div className="h-1.5 rounded-full bg-red-500 w-full" />
                </div>
            )}

            <p className="text-gray-400 text-sm mb-6 leading-relaxed">
              Your company has used all available AI requests for this billing period.
              Upgrade your plan to continue using AI actors and task execution.
            </p>

            {/* Plan limits pulled from PLAN_LABELS to stay in sync with CompanySettingsPage */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="bg-gray-900 border border-purple-800/50 rounded-xl p-3">
                <div className="flex items-center gap-1.5 mb-1 text-purple-300 font-semibold text-sm">
                  <Star size={13} /> Standard
                </div>
                <p className="text-white font-bold">$50<span className="text-gray-500 font-normal text-xs"> / mo</span></p>
                <p className="text-gray-400 text-xs mt-1">{PLAN_LABELS.standard}</p>
              </div>
              <div className="bg-gray-900 border border-amber-700/50 rounded-xl p-3">
                <div className="flex items-center gap-1.5 mb-1 text-amber-300 font-semibold text-sm">
                  <Rocket size={13} /> Pro
                </div>
                <p className="text-white font-bold">$100<span className="text-gray-500 font-normal text-xs"> / mo</span></p>
                <p className="text-gray-400 text-xs mt-1">{PLAN_LABELS.pro}</p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <button
                  onClick={handleUpgrade}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-purple-700 hover:bg-purple-600 text-white font-medium text-sm rounded-xl transition-colors"
              >
                Upgrade plan <ArrowRight size={15} />
              </button>
              <button
                  onClick={onClose}
                  className="w-full py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors"
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>
      </div>
  )
}
