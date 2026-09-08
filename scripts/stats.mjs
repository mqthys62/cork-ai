#!/usr/bin/env node
/**
 * Community stats from PostHog → docs/stats.json, shields.io badges, README block.
 *
 *   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/stats.mjs            # write files
 *   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/stats.mjs --print    # just show the numbers
 *
 * Run weekly by .github/workflows/stats.yml. Every figure is an aggregate over
 * installs that opted into telemetry — the latest daily snapshot of each — and
 * says so in the README. Below MIN_INSTALLS the README is left untouched (a
 * "community" of two installs is not a statistic); stats.json and the badges
 * are still written so the pipeline can be checked end to end.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POSTHOG_HOST = process.env.POSTHOG_API_HOST ?? 'https://eu.posthog.com'
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID ?? '269565'
const KEY = process.env.POSTHOG_PERSONAL_API_KEY
const MIN_INSTALLS = Number(process.env.MIN_INSTALLS ?? 5)
const PRINT_ONLY = process.argv.includes('--print')
const REPO = 'mqthys62/cork-ai'

if (!KEY) { console.error('Set POSTHOG_PERSONAL_API_KEY (read access to the project is enough).'); process.exit(1) }

async function hogql(query) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  })
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error)
  return body.results
}

const LATEST = `select distinct_id, argMax(properties, timestamp) as p from events where event = 'savings_snapshot' group by distinct_id`

const [[installs, tokensSaved, netUsd, grossUsd, sessions, readsOutlined, avgSavedPct, medianAmp, avgSaving200k, avgReread]] = await hogql(`
  select count(), sum(toIntOrZero(p.saved_tokens)), round(sum(toFloatOrZero(p.net_usd)), 2), round(sum(toFloatOrZero(p.saved_usd_lifetime)), 2),
         sum(toIntOrZero(p.sessions)), sum(toIntOrZero(p.requests)), round(avg(toFloatOrZero(p.saved_pct)), 1),
         round(quantile(0.5)(toFloatOrZero(p.amplification)), 1), round(avg(toFloatOrZero(p.saving_at_200k_pct_30d)), 1), round(avg(toFloatOrZero(p.reread_rate_pct)), 1)
  from (${LATEST})`)
const [[installsEver, countries]] = await hogql(`select count(distinct distinct_id), count(distinct properties.$geoip_country_code) from events where properties.$lib = 'cork-ai'`)
const [[activeInstalls30d]] = await hogql(`select count(distinct distinct_id) from events where properties.$lib = 'cork-ai' and timestamp > now() - interval 30 day`)
const [[downloads]] = await hogql(`select argMax(toIntOrZero(properties.total), timestamp) from events where event = 'release_downloads'`)

const stats = {
  updated: new Date().toISOString().slice(0, 10),
  source: 'PostHog Cloud EU — installs that opted into telemetry (cork-ai telemetry on); latest daily snapshot per install',
  installs_with_snapshot: installs,
  installs_ever_seen: installsEver,
  active_installs_30d: activeInstalls30d,
  countries,
  github_downloads: downloads ?? null,
  tokens_saved: tokensSaved,
  net_usd_saved: netUsd,
  gross_usd_saved: grossUsd,
  sessions,
  reads_outlined: readsOutlined,
  avg_saved_pct: avgSavedPct,
  median_amplification: medianAmp,
  avg_reread_rate_pct: avgReread,
  avg_saving_at_200k_pct: avgSaving200k,
}

const compact = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n))
const usd = n => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

console.log(JSON.stringify(stats, null, 2))
if (PRINT_ONLY) process.exit(0)

fs.mkdirSync(path.join(ROOT, 'docs', 'badges'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'docs', 'stats.json'), JSON.stringify(stats, null, 2) + '\n')
const badge = (label, message, color = '2ea44f') => JSON.stringify({ schemaVersion: 1, label, message, color }) + '\n'
fs.writeFileSync(path.join(ROOT, 'docs', 'badges', 'tokens-saved.json'), badge('tokens kept out of context', compact(tokensSaved)))
fs.writeFileSync(path.join(ROOT, 'docs', 'badges', 'usd-saved.json'), badge('net saved', usd(netUsd)))
fs.writeFileSync(path.join(ROOT, 'docs', 'badges', 'installs.json'), badge('installs sharing stats', String(installsEver), '007ec6'))
console.log('\nwrote docs/stats.json and docs/badges/*.json')

if (installs < MIN_INSTALLS) {
  console.log(`README left untouched: ${installs} install(s) with a snapshot, ${MIN_INSTALLS} needed.`)
  process.exit(0)
}

const block = `<!-- cork-ai:stats -->
> **Community numbers** — from the ${installsEver} installs that opted into telemetry (\`cork-ai telemetry on\`), updated ${stats.updated}.
>
> | Tokens kept out of context | Net saved | Sessions | Median cache amplification | Avg. saving with auto-compact at 200k |
> |---:|---:|---:|---:|---:|
> | **${compact(tokensSaved)}** | **${usd(netUsd)}** | ${sessions.toLocaleString('en-US')} | ${medianAmp}× | ${avgSaving200k}% |
>
> Net = gross saving at cache-read prices minus every re-read penalty. Raw figures and method: [docs/stats.json](docs/stats.json), [docs/TELEMETRY.md](docs/TELEMETRY.md).
<!-- /cork-ai:stats -->`

const readme = path.join(ROOT, 'README.md')
const text = fs.readFileSync(readme, 'utf-8')
const re = /<!-- cork-ai:stats -->[\s\S]*?<!-- \/cork-ai:stats -->/
if (!re.test(text)) { console.error('README.md has no <!-- cork-ai:stats --> block'); process.exit(1) }
const next = text.replace(re, block)
if (next !== text) { fs.writeFileSync(readme, next); console.log('README.md stats block updated') } else console.log('README.md stats block unchanged')
