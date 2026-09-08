#!/usr/bin/env node
/**
 * Adoption snapshot for maintainers: how many people downloaded cork-ai versus
 * how many opted into telemetry. Users with telemetry off send nothing (by
 * design), so the denominator comes from GitHub's public download counts.
 *
 *   node scripts/adoption.mjs                       # downloads only (public API)
 *   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/adoption.mjs   # + distinct installs, events by type
 *
 * The personal API key is read-only for the project and must never be committed.
 */

const REPO = 'mqthys62/cork-ai'
const POSTHOG_HOST = 'https://eu.posthog.com'
const POSTHOG_PROJECT_ID = '269565'
const DAYS = Number(process.env.DAYS ?? 30)

async function githubDownloads() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cork-ai-adoption' } })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const releases = await res.json()
  const rows = releases.map(r => ({ tag: r.tag_name, published: r.published_at?.slice(0, 10), downloads: (r.assets ?? []).filter(a => !a.name.endsWith('.txt')).reduce((s, a) => s + a.download_count, 0) }))
  return rows
}

async function hogql(query, key) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  })
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).results
}

const downloads = await githubDownloads()
const total = downloads.reduce((s, r) => s + r.downloads, 0)
console.log(`\nGitHub release downloads (all time)`)
for (const r of downloads) console.log(`  ${r.tag.padEnd(10)} ${String(r.downloads).padStart(6)}   ${r.published ?? ''}`)
console.log(`  ${'total'.padEnd(10)} ${String(total).padStart(6)}`)

const key = process.env.POSTHOG_PERSONAL_API_KEY
if (!key) {
  console.log(`\nSet POSTHOG_PERSONAL_API_KEY to add telemetry figures (distinct installs, events).\n`)
  process.exit(0)
}

const since = `now() - interval ${DAYS} day`
const [[installs]] = await hogql(`select count(distinct distinct_id) from events where timestamp > ${since}`, key)
const [[optedIn]] = await hogql(`select count(distinct distinct_id) from events where event = 'telemetry_toggled' and properties.enabled = true`, key)
const [[optedOut]] = await hogql(`select count(distinct distinct_id) from events where event = 'telemetry_toggled' and properties.enabled = false`, key)
const byEvent = await hogql(`select event, count() from events where timestamp > ${since} group by event order by count() desc`, key)
const versions = await hogql(`select properties.version, count(distinct distinct_id) from events where timestamp > ${since} group by properties.version order by 2 desc`, key)
const decisions = await hogql(`select properties.decision, properties.reason, count() from events where event = 'hook_read' and timestamp > ${since} group by 1, 2 order by 3 desc limit 15`, key)

console.log(`\nTelemetry (last ${DAYS} days)`)
console.log(`  active installs with telemetry on   ${installs}`)
console.log(`  ever opted in / later opted out     ${optedIn} / ${optedOut}`)
if (total > 0) console.log(`  telemetry-on share of downloads     ${((installs / total) * 100).toFixed(1)}%  (downloads count every re-install and CI fetch — a ceiling, not a user count)`)
console.log(`\n  events`)
for (const [event, n] of byEvent) console.log(`    ${String(event).padEnd(20)} ${String(n).padStart(8)}`)
console.log(`\n  versions (distinct installs)`)
for (const [v, n] of versions) console.log(`    ${String(v ?? '?').padEnd(20)} ${String(n).padStart(8)}`)
console.log(`\n  hook_read decisions`)
for (const [d, r, n] of decisions) console.log(`    ${String(d).padEnd(8)} ${String(r ?? '').padEnd(24)} ${String(n).padStart(8)}`)
console.log()
