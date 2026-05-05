export interface EnvPair {
  key: string
  value: string
  /** True when the value came from the server as '***' and the user has not re-entered it.
   *  Masked pairs are omitted from envPairsToObj so unchanged secrets are never overwritten. */
  isMasked?: boolean
}

/** Serialize pairs to a plain object for API submission.
 *  Pairs that are still masked (isMasked === true) are skipped — the server keeps its secret.
 *  Returns undefined when nothing is left (so the field is omitted from the request body). */
export function envPairsToObj(pairs: EnvPair[]): Record<string, string> | undefined {
  const obj: Record<string, string> = {}
  for (const { key, value, isMasked } of pairs) {
    if (isMasked) continue  // user did not re-enter; leave server secret untouched
    if (key.trim()) obj[key.trim()] = value
  }
  return Object.keys(obj).length ? obj : undefined
}

/** Convert a server extra_env object into editable pairs.
 *  Keys whose value is '***' are marked isMasked so they survive a save round-trip. */
export function envObjToPairs(obj: Record<string, string> | null | undefined): EnvPair[] {
  if (!obj) return []
  return Object.keys(obj).map((k) =>
    obj[k] === '***'
      ? { key: k, value: '', isMasked: true }
      : { key: k, value: obj[k] }
  )
}
