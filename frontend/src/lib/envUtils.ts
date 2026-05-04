export interface EnvPair { key: string; value: string }

export function envPairsToObj(pairs: EnvPair[]): Record<string, string> | undefined {
  const obj: Record<string, string> = {}
  for (const { key, value } of pairs) {
    if (key.trim()) obj[key.trim()] = value
  }
  return Object.keys(obj).length ? obj : undefined
}

export function envObjToPairs(obj: Record<string, string> | null | undefined): EnvPair[] {
  if (!obj) return []
  return Object.keys(obj).map((k) => ({ key: k, value: obj[k] === '***' ? '' : obj[k] }))
}
