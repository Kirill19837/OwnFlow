import { useAiLimitStore } from '../store/aiLimitStore'

/**
 * Parses a 402 response detail string of the form "N/M" and opens the
 * AI-limit modal with the extracted numbers (or without them if absent).
 *
 * Extracted separately so the same logic can be called from both the
 * fetch-based helper below AND the Axios 402 interceptor in lib/api.ts.
 */
export function openLimitModalFromDetail(detail: string): void {
    const match = detail.match(/(\d+)\/(\d+)/)
    useAiLimitStore.getState().open(
        match ? { used: Number(match[1]), limit: Number(match[2]) } : {}
    )
}

/**
 * Drop-in wrapper around `fetch` that intercepts HTTP 402 responses,
 * opens the AI-limit modal, and throws so callers can bail out cleanly.
 *
 * Usage (identical to plain `fetch`):
 *   const res = await fetchWithAiLimitCheck(url, { method: 'POST', … })
 */
export async function fetchWithAiLimitCheck(
    input: RequestInfo,
    init?: RequestInit
): Promise<Response> {
    const res = await fetch(input, init)

    if (res.status === 402) {
        try {
            const body = await res.clone().json()
            const detail: string = body?.detail ?? ''
            openLimitModalFromDetail(detail)
        } catch {
            useAiLimitStore.getState().open()
        }
        throw new Error('AI prompt limit reached')
    }

    return res
}
