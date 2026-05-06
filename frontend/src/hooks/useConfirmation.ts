import { useState, useCallback, type ReactNode } from 'react'

export interface ConfirmationConfig {
  title: string
  message: string | ReactNode
  confirmText?: string
  cancelText?: string
  isDangerous?: boolean
}

interface ConfirmationState extends ConfirmationConfig {
  id: string
  onConfirm: () => void
  onCancel: () => void
}

let confirmationId = 0

export function useConfirmation() {
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)

  const confirm = useCallback((config: ConfirmationConfig): Promise<boolean> => {
    return new Promise((resolve) => {
      const id = String(++confirmationId)
      const onConfirm = () => {
        setConfirmation(null)
        resolve(true)
      }
      const onCancel = () => {
        setConfirmation(null)
        resolve(false)
      }
      setConfirmation({ ...config, id, onConfirm, onCancel })
    })
  }, [])

  return { confirmation, confirm }
}

export type { ConfirmationState }

