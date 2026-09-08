/** Single source of truth for the CLI version (kept in sync with package.json by the release checklist). */
export const VERSION = '1.0.0-rc.1'

/** Semver order, pre-releases included: 1.0.0-rc.1 < 1.0.0-rc.2 < 1.0.0. */
export function compareVersions(a: string, b: string): number {
  const [ca, pa] = splitPre(a), [cb, pb] = splitPre(b)
  for (let i = 0; i < 3; i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0)
    if (d !== 0) return d
  }
  if (!pa && !pb) return 0
  if (!pa) return 1
  if (!pb) return -1
  const xa = pa.split('.'), xb = pb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const sa = xa[i], sb = xb[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    const na = Number(sa), nb = Number(sb)
    const d = Number.isNaN(na) || Number.isNaN(nb) ? sa.localeCompare(sb) : na - nb
    if (d !== 0) return d
  }
  return 0
}

function splitPre(v: string): [number[], string] {
  const [core, pre = ''] = v.replace(/^v/, '').split('-', 2)
  return [core.split('.').map(n => Number(n) || 0), pre]
}
