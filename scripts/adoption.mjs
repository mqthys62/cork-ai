#!/usr/bin/env node
/**
 * Adoption for maintainers: how many people downloaded cork-ai versus how many
 * opted into telemetry. Users with telemetry off send nothing (by design), so
 * the denominator is GitHub's public download counts.
 *
 *   node scripts/adoption.mjs                                  # downloads only (public API)
 *   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/adoption.mjs   # + installs, events, decisions
 *   node scripts/adoption.mjs --push                           # push the download counts to PostHog
 *
 * `--push` is what .github/workflows/adoption.yml runs daily: it records one
 * `release_downloads` event per release plus a total, so the Adoption
 * dashboard can put downloads next to installs. It uses the write-only project
 * token — no secret needed. The personal API key (read) must never be committed.
 */

const REPO = 'mqthys62/cork-ai'
const POSTHOG_HOST = 'https://eu.posthog.com'
const POSTHOG_CAPTURE = 'https://eu.i.posthog.com/capture/'
const POSTHOG_PROJECT_ID = '269565'
/** Write-only project token — the same one embedded in the binary. */
const POSTHOG_PROJECT_TOKEN = 'phc_u5LpaZ4J9TNdPbZU3UF3Jh5Egn3BTFxcBxtX9FNJ7ove'
const DAYS = Number(process.env.DAYS ?? 30)
const PUSH = process.argv.includes('--push')

async function githubDownloads() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cork-ai-adoption' } })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const releases = await res.json()
  return releases.map(r => ({
    tag: r.tag_name,
    published: r.published_at?.slice(0, 10),
    downloads: (r.assets ?? []).filter(a => !a.name.endsWith('.txt')).reduce((s, a) => s + a.download_count, 0),
    byAsset: Object.fromEntries((r.assets ?? []).filter(a => !a.name.endsWith('.txt')).map(a => [a.name.replace(/^cork-ai-/, '').replace(/\.exe$/, ''), a.download_count])),
  }))
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

/** One `release_downloads` event per release, plus one with tag `all`. */
async function pushDownloads(rows, total) {
  const now = new Date().toISOString()
  const events = [
    ...rows.map(r => ({ tag: r.tag, published: r.published, downloads: r.downloads, ...Object.fromEntries(Object.entries(r.byAsset).map(([k, v]) => [`dl_${k.replace(/[^a-z0-9]/gi, '_')}`, v])) })),
    { tag: 'all', downloads: total, total, releases: rows.length },
  ].map(properties => ({
    event: 'release_downloads',
    distinct_id: `github:${REPO}`,
    timestamp: now,
    properties: { $lib: 'cork-ai-ci', total, $process_person_profile: false, ...properties },
  }))
  const res = await fetch(POSTHOG_CAPTURE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: POSTHOG_PROJECT_TOKEN, batch: events }),
  })
  if (!res.ok) throw new Error(`PostHog capture ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return events.length
}

const downloads = await githubDownloads()
const total = downloads.reduce((s, r) => s + r.downloads, 0)
console.log(`\nGitHub release downloads (all time)`)
for (const r of downloads) console.log(`  ${r.tag.padEnd(10)} ${String(r.downloads).padStart(6)}   ${r.published ?? ''}`)
console.log(`  ${'total'.padEnd(10)} ${String(total).padStart(6)}`)

if (PUSH) {
  const n = await pushDownloads(downloads, total)
  console.log(`\n  pushed ${n} release_downloads event(s) to PostHog\n`)
  process.exit(0)
}

const key = process.env.POSTHOG_PERSONAL_API_KEY
if (!key) {
  console.log(`\nSet POSTHOG_PERSONAL_API_KEY to add telemetry figures (distinct installs, events).\n`)
  process.exit(0)
}

const since = `now() - interval ${DAYS} day`
const client = `properties.$lib = 'cork-ai'`
const [[installsEver]] = await hogql(`select count(distinct distinct_id) from events where ${client}`, key)
const [[installs]] = await hogql(`select count(distinct distinct_id) from events where ${client} and timestamp > ${since}`, key)
const [[optedIn]] = await hogql(`select count(distinct distinct_id) from events where event = 'telemetry_toggled' and properties.enabled = true`, key)
const [[optedOut]] = await hogql(`select count(distinct distinct_id) from events where event = 'telemetry_toggled' and properties.enabled = false`, key)
const byEvent = await hogql(`select event, count() from events where ${client} and timestamp > ${since} group by event order by count() desc`, key)
const versions = await hogql(`select properties.version, count(distinct distinct_id) from events where ${client} and timestamp > ${since} group by properties.version order by 2 desc`, key)
const decisions = await hogql(`select properties.decision, properties.reason, count() from events where event = 'hook_read' and timestamp > ${since} group by 1, 2 order by 3 desc limit 15`, key)
const [totals] = await hogql(`
  select count(), sum(toIntOrZero(p.saved_tokens)), round(sum(toFloatOrZero(p.net_usd)), 2), round(avg(toFloatOrZero(p.reread_rate_pct)), 1), round(avg(toFloatOrZero(p.saving_at_200k_pct_30d)), 1)
  from (select distinct_id, argMax(properties, timestamp) as p from events where event = 'savings_snapshot' group by distinct_id)`, key)

console.log(`\nTelemetry`)
console.log(`  installs ever seen                  ${installsEver}`)
console.log(`  active in the last ${String(DAYS).padEnd(3)} days       ${installs}`)
console.log(`  ever opted in / later opted out     ${optedIn} / ${optedOut}`)
if (total > 0) console.log(`  telemetry-on share of downloads     ${((installsEver / total) * 100).toFixed(1)}%  (downloads count every re-install and CI fetch — a ceiling, not a user count)`)
if (totals && totals[0] > 0) {
  console.log(`\n  community totals (latest snapshot per install)`)
  console.log(`    installs with a snapshot          ${totals[0]}`)
  console.log(`    tokens kept out of context        ${Number(totals[1]).toLocaleString('en-US')}`)
  console.log(`    net USD saved                     $${totals[2]}`)
  console.log(`    avg re-read rate                  ${totals[3]}%`)
  console.log(`    avg saving with auto-compact 200k ${totals[4]}%`)
}
console.log(`\n  events (last ${DAYS} days)`)
for (const [event, n] of byEvent) console.log(`    ${String(event).padEnd(20)} ${String(n).padStart(8)}`)
console.log(`\n  versions (distinct installs)`)
for (const [v, n] of versions) console.log(`    ${String(v ?? '?').padEnd(20)} ${String(n).padStart(8)}`)
console.log(`\n  hook_read decisions`)
for (const [d, r, n] of decisions) console.log(`    ${String(d).padEnd(8)} ${String(r ?? '').padEnd(24)} ${String(n).padStart(8)}`)
console.log()
