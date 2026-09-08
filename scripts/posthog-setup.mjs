#!/usr/bin/env node
/**
 * One-shot, idempotent setup of the cork-ai PostHog project (maintainers only).
 *
 *   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-setup.mjs
 *   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-setup.mjs --dry-run
 *
 * What it does, and re-does safely on every run (everything is matched by name):
 *   1. Project hygiene — IP anonymisation on; a transformation that blanks the
 *      city-level GeoIP properties PostHog adds (country and time zone stay).
 *   2. Event and property descriptions, so the Data Management tab reads like
 *      docs/TELEMETRY.md.
 *   3. Four dashboards — Overview, Savings, Context, Adoption — with every
 *      insight defined below. Existing insights are updated in place, so this
 *      file is the source of truth: edit here, run again.
 *
 * The personal API key needs project write scopes (project settings,
 * transformations, insights, dashboards, event definitions). It must never be
 * committed — pass it through the environment.
 */

const HOST = process.env.POSTHOG_API_HOST ?? 'https://eu.posthog.com'
const PROJECT = process.env.POSTHOG_PROJECT_ID ?? '269565'
const KEY = process.env.POSTHOG_PERSONAL_API_KEY
const DRY = process.argv.includes('--dry-run')
const TAG = 'cork-ai'

if (!KEY) {
  console.error('Set POSTHOG_PERSONAL_API_KEY (a personal API key with write access to the project).')
  process.exit(1)
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function api(method, route, body) {
  const url = route.startsWith('http') ? route : `${HOST}/api/projects/${PROJECT}/${route}`
  if (DRY && method !== 'GET') { console.log(`  [dry-run] ${method} ${route} ${body ? JSON.stringify(body).slice(0, 120) : ''}`); return {} }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.status === 204 ? {} : res.json()
}

async function listAll(route) {
  const out = []
  let next = `${HOST}/api/projects/${PROJECT}/${route}${route.includes('?') ? '&' : '?'}limit=100`
  while (next) {
    const page = await api('GET', next)
    out.push(...(page.results ?? []))
    next = page.next
  }
  return out
}

// ─── 1. Project hygiene ──────────────────────────────────────────────────────

const GEOIP_PRECISE = [
  '$geoip_city_name', '$geoip_city_confidence', '$geoip_postal_code', '$geoip_latitude', '$geoip_longitude', '$geoip_accuracy_radius',
  '$geoip_subdivision_1_code', '$geoip_subdivision_1_name', '$geoip_subdivision_2_code', '$geoip_subdivision_2_name',
  '$geoip_subdivision_3_code', '$geoip_subdivision_3_name',
]

async function ensureProjectHygiene() {
  const project = await api('GET', '')
  if (project.anonymize_ips !== true) {
    await api('PATCH', '', { anonymize_ips: true })
    console.log('  ✔ anonymize_ips → true')
  } else console.log('  · anonymize_ips already true')

  const name = 'cork-ai: GeoIP at country level only'
  const existing = (await listAll('hog_functions/?type=transformation')).find(f => f.name === name)
  const props = [...GEOIP_PRECISE, ...GEOIP_PRECISE.map(p => `$set.${p}`), ...GEOIP_PRECISE.map(p => `$set_once.${p}`)].join(', ')
  const payload = {
    type: 'transformation',
    template_id: 'template-filter-properties',
    name,
    description: 'Blanks the city, postal code, coordinates and region PostHog derives from the IP. Country, continent and time zone are kept — enough to know where cork-ai is used, not where someone lives.',
    enabled: true,
    execution_order: 2,
    inputs: { propertiesToFilter: { value: props } },
  }
  if (existing) {
    await api('PATCH', `hog_functions/${existing.id}/`, { inputs: payload.inputs, enabled: true, description: payload.description })
    console.log(`  · transformation "${name}" updated`)
  } else {
    await api('POST', 'hog_functions/', payload)
    console.log(`  ✔ transformation "${name}" created`)
  }
}

// ─── 2. Data management descriptions ─────────────────────────────────────────

const EVENT_DESCRIPTIONS = {
  install: 'cork-ai hooks install — hooks added, whether it was an upgrade, the autoCompactWindow chosen.',
  telemetry_toggled: 'cork-ai telemetry on/off. The off event is sent before the switch.',
  command: 'A CLI command ran (gain, context, doctor, …). Name and flag only.',
  session_start: 'First hook event of a Claude Code session. Counts sessions even when SessionEnd never fires.',
  hook_read: 'A whole-file read the hook decided on: outline or raw, and why. Token and context buckets, extension, model family.',
  hook_reread: 'A file served as an outline was read again (full or range). The compression-harm signal.',
  guard_notice: 'The context guard crossed a band (150k/300k/500k/750k tokens) and notified the user/model.',
  session_digest: 'Claude Code SessionEnd: turns, context buckets, cost bucket, saving at 200k, compactions, outlines, re-reads, tokens saved.',
  savings_snapshot: 'Daily aggregate of everything cork-ai measured on the install: tokens and USD saved (exact), re-read rate, amplification, 30-day context picture (spend bucketed), setup.',
  release_downloads: 'Pushed daily by GitHub Actions: download counts of the GitHub release assets. The adoption denominator (users with telemetry off send nothing).',
}

const PROPERTY_DESCRIPTIONS = {
  version: 'cork-ai version.',
  claude_version: 'Claude Code version, read from the transcript.',
  runtime: 'bun-1 for the standalone binary, node-NN from npm.',
  decision: 'hook_read: outline (compressed view served) or raw (file passed through).',
  reason: 'Why a read was served raw (user-mentioned, skip-list, editing, probation, expected-value, …) or why a session ended.',
  ext: 'File extension, lower-cased. Never the name.',
  source: 'Read tool, or the shell command used (cat, sed, head, …).',
  tokens: 'Token bucket of the file (<500 … >15k).',
  context: 'Context-size bucket at that moment (<50k … >750k).',
  model: 'Model family (opus-5, sonnet-5, fable-5-1). Never the raw id.',
  p_reread: 'Learned re-read probability for the extension, percent.',
  saved_pct: 'Share of the file kept out of context by the outline.',
  saved_tokens: 'Tokens kept out of context (session_digest: this session; savings_snapshot: lifetime).',
  net_usd: 'Lifetime USD saved after re-read penalties, valued at cache-read prices over the tokens\' life in context.',
  amplification: 'Median cache reads per token written: how many times a token is re-billed over a session.',
  reread_rate_pct: 'Re-reads over outlines served, percent.',
  context_avg_30d: 'Average context size per turn over the last 30 days, tokens.',
  saving_at_200k_pct_30d: 'What the last 30 days would have saved with auto-compaction at 200k tokens, percent.',
  cache_read_share_pct_30d: 'Share of the 30-day spend that is cache reads of the whole context.',
  spend_30d: 'Bucketed 30-day spend (<$1 … >$100). Exact spend is never sent.',
  autocompact_window: 'Claude Code autoCompactWindow setting, tokens, or null.',
  band: 'Guard band crossed, tokens.',
  cost: 'Session cost bucket.',
  turns: 'Assistant turns in the session.',
  duration_min: 'Session length, minutes, from the first hook event.',
  tag: 'release_downloads: release tag.',
  downloads: 'release_downloads: downloads of that release\'s binaries.',
  total: 'release_downloads: downloads across all releases.',
}

async function describeDefinitions() {
  const events = await listAll('event_definitions/')
  let n = 0
  for (const def of events) {
    const description = EVENT_DESCRIPTIONS[def.name]
    if (!description || def.description === description) continue
    await api('PATCH', `event_definitions/${def.id}/`, { description })
    n++
  }
  console.log(`  ✔ ${n} event description(s) written (${events.filter(e => EVENT_DESCRIPTIONS[e.name]).length} known events seen so far)`)
  const props = await listAll('property_definitions/?type=event')
  let m = 0
  for (const def of props) {
    const description = PROPERTY_DESCRIPTIONS[def.name]
    if (!description || def.description === description) continue
    await api('PATCH', `property_definitions/${def.id}/`, { description })
    m++
  }
  console.log(`  ✔ ${m} property description(s) written`)
}

// ─── 3. Dashboards and insights ──────────────────────────────────────────────

/** Only cork-ai clients — the CI's release_downloads events carry another $lib. */
const CLIENT_FILTER = [{ key: '$lib', value: ['cork-ai'], operator: 'exact', type: 'event' }]

function events(event, extra = {}) {
  return { kind: 'EventsNode', event, name: event ?? 'All events', ...extra }
}

function trends({ series, interval = 'day', from = '-30d', display = 'ActionsLineGraph', breakdown, formula, filters = CLIENT_FILTER, compare = false }) {
  const source = {
    kind: 'TrendsQuery',
    series,
    interval,
    dateRange: { date_from: from },
    trendsFilter: { display, ...(formula ? { formula } : {}) },
    properties: filters,
    filterTestAccounts: false,
    ...(compare ? { compareFilter: { compare: true } } : {}),
  }
  if (breakdown) source.breakdownFilter = { breakdown, breakdown_type: 'event' }
  return { kind: 'InsightVizNode', source }
}

function hogql(query) {
  return { kind: 'DataTableNode', source: { kind: 'HogQLQuery', query: query.trim() }, showSearch: false, showExport: true }
}

function retention() {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'RetentionQuery',
      retentionFilter: {
        targetEntity: { id: 'session_start', type: 'events', name: 'session_start' },
        returningEntity: { id: 'session_start', type: 'events', name: 'session_start' },
        period: 'Week',
        totalIntervals: 8,
        retentionType: 'retention_first_time',
      },
      properties: CLIENT_FILTER,
    },
  }
}

/** Latest savings_snapshot per install — the per-user gauge every lifetime figure is read from. */
const LATEST_SNAPSHOT = `
  select distinct_id, argMax(properties, timestamp) as p, max(timestamp) as at
  from events where event = 'savings_snapshot' group by distinct_id`

const DASHBOARDS = [
  {
    name: 'cork-ai · Overview',
    description: 'Reach and activity of installs that opted into telemetry: how many, on what, doing what.',
    pinned: true,
    insights: [
      { name: 'Installs with telemetry on (all time)', description: 'Distinct install ids that ever sent an event.', query: trends({ series: [events(null, { math: 'dau' })], from: 'all', display: 'BoldNumber' }) },
      { name: 'Active installs — daily / weekly / monthly', query: trends({ series: [events(null, { math: 'dau', custom_name: 'daily' }), events(null, { math: 'weekly_active', custom_name: 'weekly' }), events(null, { math: 'monthly_active', custom_name: 'monthly' })] }) },
      { name: 'New installs per week', description: '`install` events that were not upgrades.', query: trends({ series: [events('install', { math: 'dau', properties: [{ key: 'upgrade', value: ['false'], operator: 'exact', type: 'event' }] })], interval: 'week', from: '-90d', display: 'ActionsBar' }) },
      { name: 'Sessions per day', description: 'session_start (first hook event) vs session_digest (clean SessionEnd).', query: trends({ series: [events('session_start', { math: 'total' }), events('session_digest', { math: 'total' })] }) },
      { name: 'cork-ai versions in use (7 days)', query: trends({ series: [events(null, { math: 'dau' })], from: '-7d', display: 'ActionsPie', breakdown: 'version' }) },
      { name: 'Claude Code versions (7 days)', query: trends({ series: [events(null, { math: 'dau' })], from: '-7d', display: 'ActionsBarValue', breakdown: 'claude_version' }) },
      { name: 'Operating systems', query: trends({ series: [events(null, { math: 'dau' })], display: 'ActionsPie', breakdown: 'os' }) },
      { name: 'Runtime (binary vs npm)', query: trends({ series: [events(null, { math: 'dau' })], display: 'ActionsPie', breakdown: 'runtime' }) },
      { name: 'Countries', query: trends({ series: [events(null, { math: 'dau' })], display: 'WorldMap', breakdown: '$geoip_country_code' }) },
      { name: 'Commands used', query: trends({ series: [events('command', { math: 'total' })], display: 'ActionsBarValue', breakdown: 'command' }) },
      { name: 'Weekly retention (sessions)', description: 'Of the installs whose first session was in a given week, how many still ran a session N weeks later.', query: retention() },
      { name: 'Telemetry opt-ins and opt-outs', query: trends({ series: [events('telemetry_toggled', { math: 'dau' })], interval: 'week', from: '-90d', display: 'ActionsBar', breakdown: 'enabled' }) },
    ],
  },
  {
    name: 'cork-ai · Savings',
    description: 'What cork-ai keeps out of context and what it is worth — the figures the README quotes. Lifetime numbers come from the latest daily snapshot of each install.',
    pinned: true,
    insights: [
      {
        name: 'Community totals',
        description: 'Sum over installs of their lifetime figures (latest snapshot each).',
        query: hogql(`
          select
            count() as installs,
            sum(toIntOrZero(p.saved_tokens)) as tokens_saved,
            round(sum(toFloatOrZero(p.net_usd)), 2) as net_usd_saved,
            round(sum(toFloatOrZero(p.saved_usd_lifetime)), 2) as gross_usd_saved,
            sum(toIntOrZero(p.sessions)) as sessions,
            sum(toIntOrZero(p.requests)) as reads_outlined,
            round(avg(toFloatOrZero(p.saved_pct)), 1) as avg_saved_pct,
            round(avg(toFloatOrZero(p.reread_rate_pct)), 1) as avg_reread_rate_pct,
            round(quantile(0.5)(toFloatOrZero(p.amplification)), 1) as median_amplification
          from (${LATEST_SNAPSHOT})`),
      },
      {
        name: 'Per-install distribution (lifetime)',
        description: 'Quartiles across installs: tokens saved, net USD, re-read rate, tracking days.',
        query: hogql(`
          select
            quantiles(0.25, 0.5, 0.75)(toIntOrZero(p.saved_tokens)) as tokens_saved_q,
            quantiles(0.25, 0.5, 0.75)(toFloatOrZero(p.net_usd)) as net_usd_q,
            quantiles(0.25, 0.5, 0.75)(toFloatOrZero(p.reread_rate_pct)) as reread_rate_q,
            quantiles(0.25, 0.5, 0.75)(toIntOrZero(p.tracking_days)) as tracking_days_q,
            countIf(toFloatOrZero(p.net_usd) < 0) as installs_with_negative_net
          from (${LATEST_SNAPSHOT})`),
      },
      { name: 'Tokens kept out of context per day', description: 'Sum of session_digest.saved_tokens.', query: trends({ series: [events('session_digest', { math: 'sum', math_property: 'saved_tokens' })], display: 'ActionsBar' }) },
      { name: 'Outlines served vs re-reads', query: trends({ series: [events('hook_read', { math: 'total', properties: [{ key: 'decision', value: ['outline'], operator: 'exact', type: 'event' }], custom_name: 'outlines' }), events('hook_reread', { math: 'total', custom_name: 're-reads' })] }) },
      { name: 'Re-read rate (%)', description: 're-reads / outlines served. The number the EV gate exists to push down.', query: trends({ series: [events('hook_read', { math: 'total', properties: [{ key: 'decision', value: ['outline'], operator: 'exact', type: 'event' }] }), events('hook_reread', { math: 'total' })], formula: 'B / A * 100', interval: 'week', from: '-90d' }) },
      { name: 'Read decisions', query: trends({ series: [events('hook_read', { math: 'total' })], display: 'ActionsPie', breakdown: 'decision' }) },
      { name: 'Why reads were served raw', query: trends({ series: [events('hook_read', { math: 'total', properties: [{ key: 'decision', value: ['raw'], operator: 'exact', type: 'event' }] })], display: 'ActionsBarValue', breakdown: 'reason' }) },
      { name: 'Outlines by file type', query: trends({ series: [events('hook_read', { math: 'total', properties: [{ key: 'decision', value: ['outline'], operator: 'exact', type: 'event' }] })], display: 'ActionsBarValue', breakdown: 'ext' }) },
      { name: 'Re-reads by file type', query: trends({ series: [events('hook_reread', { math: 'total' })], display: 'ActionsBarValue', breakdown: 'ext' }) },
      { name: 'Read source (Read tool vs shell)', description: 'Auto mode reads through cat/sed/head — the reason the Bash hook exists.', query: trends({ series: [events('hook_read', { math: 'total' })], display: 'ActionsPie', breakdown: 'source' }) },
      { name: 'Average saving per outline (%)', query: trends({ series: [events('hook_read', { math: 'avg', math_property: 'saved_pct', properties: [{ key: 'decision', value: ['outline'], operator: 'exact', type: 'event' }] })] }) },
      { name: 'File size of outlined reads', query: trends({ series: [events('hook_read', { math: 'total', properties: [{ key: 'decision', value: ['outline'], operator: 'exact', type: 'event' }] })], display: 'ActionsBarValue', breakdown: 'tokens' }) },
      { name: 'Edit failures after an outline', description: 'An Edit whose old_string was missing because the model only saw the outline. Should stay near zero.', query: trends({ series: [events('session_digest', { math: 'sum', math_property: 'edit_failures' })], display: 'ActionsBar' }) },
      { name: 'Models (reads)', query: trends({ series: [events('hook_read', { math: 'total' })], display: 'ActionsPie', breakdown: 'model' }) },
    ],
  },
  {
    name: 'cork-ai · Context',
    description: 'Context governance: how big contexts get, what cache reads cost, and how much auto-compaction at 200k would save. The lever that dwarfs read compression.',
    pinned: true,
    insights: [
      {
        name: 'Context picture (30 days, per install)',
        description: 'Averages across installs of their own 30-day figures: context per turn, cache-read share of spend, saving at 200k.',
        query: hogql(`
          select
            count() as installs,
            round(avg(toFloatOrZero(p.context_avg_30d))) as avg_context_per_turn,
            round(quantile(0.5)(toFloatOrZero(p.context_avg_30d))) as median_context_per_turn,
            round(avg(toFloatOrZero(p.cache_read_share_pct_30d)), 1) as avg_cache_read_share_pct,
            round(avg(toFloatOrZero(p.saving_at_200k_pct_30d)), 1) as avg_saving_at_200k_pct,
            round(quantile(0.5)(toFloatOrZero(p.saving_at_200k_pct_30d)), 1) as median_saving_at_200k_pct,
            sum(toIntOrZero(p.turns_30d)) as turns_30d,
            sum(toIntOrZero(p.compactions)) as compactions_lifetime
          from (${LATEST_SNAPSHOT})`),
      },
      {
        name: 'Auto-compact adoption',
        description: 'autoCompactWindow of each install (latest snapshot). null = Claude Code default (compacts near the model limit).',
        query: hogql(`
          select ifNull(p.autocompact_window, 'default') as autocompact_window, count() as installs
          from (${LATEST_SNAPSHOT}) group by autocompact_window order by installs desc`),
      },
      {
        name: '30-day spend buckets',
        description: 'Bucketed on the client; exact spend never leaves the machine.',
        query: hogql(`
          select p.spend_30d as spend_30d, count() as installs
          from (${LATEST_SNAPSHOT}) group by spend_30d order by installs desc`),
      },
      { name: 'Context size at read time', query: trends({ series: [events('hook_read', { math: 'total' })], display: 'ActionsBarValue', breakdown: 'context' }) },
      { name: 'Guard notices by band', query: trends({ series: [events('guard_notice', { math: 'total' })], display: 'ActionsBar', breakdown: 'band', interval: 'week', from: '-90d' }) },
      { name: 'Session max context', query: trends({ series: [events('session_digest', { math: 'total' })], display: 'ActionsBarValue', breakdown: 'max_context' }) },
      { name: 'Session cost buckets', query: trends({ series: [events('session_digest', { math: 'total' })], display: 'ActionsBarValue', breakdown: 'cost' }) },
      { name: 'Saving at 200k per session (%)', description: 'Average of session_digest.saving_at_200k_pct.', query: trends({ series: [events('session_digest', { math: 'avg', math_property: 'saving_at_200k_pct' })], interval: 'week', from: '-90d' }) },
      { name: 'Compactions per session', query: trends({ series: [events('session_digest', { math: 'avg', math_property: 'compactions' })], interval: 'week', from: '-90d' }) },
      { name: 'Session length (turns, average)', query: trends({ series: [events('session_digest', { math: 'avg', math_property: 'turns' })], interval: 'week', from: '-90d' }) },
      { name: 'Session length (minutes, median)', query: trends({ series: [events('session_digest', { math: 'median', math_property: 'duration_min' })], interval: 'week', from: '-90d' }) },
      { name: 'Permission modes', description: 'auto mode is where reads go through the shell.', query: trends({ series: [events('session_start', { math: 'total' })], display: 'ActionsPie', breakdown: 'permission_mode' }) },
    ],
  },
  {
    name: 'cork-ai · Adoption',
    description: 'Downloads (GitHub, pushed daily by CI) against installs that opted into telemetry. Users who keep telemetry off send nothing, so downloads are the only denominator.',
    pinned: true,
    insights: [
      {
        name: 'Downloads vs telemetry-on installs',
        description: 'Latest GitHub download total, distinct installs seen, and the share. Downloads count every re-install and CI fetch: a ceiling, not a user count.',
        query: hogql(`
          select
            (select argMax(toIntOrZero(properties.total), timestamp) from events where event = 'release_downloads') as downloads_total,
            (select count(distinct distinct_id) from events where properties.$lib = 'cork-ai') as installs_telemetry_on,
            (select count(distinct distinct_id) from events where event = 'install') as installs_via_hooks_install,
            round(installs_telemetry_on / greatest(downloads_total, 1) * 100, 1) as telemetry_on_share_pct`),
      },
      {
        name: 'Downloads per release',
        query: hogql(`
          select properties.tag as tag, argMax(toIntOrZero(properties.downloads), timestamp) as downloads, argMax(properties.published, timestamp) as published
          from events where event = 'release_downloads' and properties.tag != 'all'
          group by tag order by published desc`),
      },
      { name: 'GitHub downloads over time', description: 'Daily maximum of the total pushed by CI.', query: trends({ series: [events('release_downloads', { math: 'max', math_property: 'total', properties: [{ key: 'tag', value: ['all'], operator: 'exact', type: 'event' }] })], from: '-90d', filters: [] }) },
      { name: 'Telemetry opt-ins per week', query: trends({ series: [events('telemetry_toggled', { math: 'dau', properties: [{ key: 'enabled', value: ['true'], operator: 'exact', type: 'event' }] })], interval: 'week', from: '-90d', display: 'ActionsBar' }) },
      { name: 'Installs by first cork-ai version', description: 'From the person profile (first_version, set once).', query: hogql(`select properties.first_version as first_version, count() as installs from persons where properties.first_version is not null group by first_version order by first_version desc`) },
      { name: 'Installs per day (cumulative)', query: trends({ series: [events('install', { math: 'dau' })], from: '-90d', display: 'ActionsLineGraphCumulative' }) },
    ],
  },
]

async function ensureDashboards() {
  const existingDashboards = await listAll('dashboards/?limit=100')
  const existingInsights = await listAll('insights/?limit=100')
  for (const spec of DASHBOARDS) {
    let dashboard = existingDashboards.find(d => d.name === spec.name && !d.deleted)
    if (dashboard) {
      await api('PATCH', `dashboards/${dashboard.id}/`, { description: spec.description, pinned: spec.pinned, tags: [TAG] })
      console.log(`  · dashboard "${spec.name}" (#${dashboard.id}) updated`)
    } else {
      dashboard = await api('POST', 'dashboards/', { name: spec.name, description: spec.description, pinned: spec.pinned, tags: [TAG] })
      console.log(`  ✔ dashboard "${spec.name}" (#${dashboard.id}) created`)
    }
    let created = 0, updated = 0
    for (const insight of spec.insights) {
      const found = existingInsights.find(i => i.name === insight.name && !i.deleted)
      const body = { name: insight.name, description: insight.description ?? '', query: insight.query, tags: [TAG], saved: true }
      if (found) {
        const dashboards = [...new Set([...(found.dashboards ?? []), dashboard.id])]
        await api('PATCH', `insights/${found.id}/`, { ...body, dashboards })
        updated++
      } else {
        await api('POST', 'insights/', { ...body, dashboards: [dashboard.id] })
        created++
      }
    }
    console.log(`    insights: ${created} created, ${updated} updated`)
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log(`\nPostHog project ${PROJECT} @ ${HOST}${DRY ? '  (dry run)' : ''}\n`)
console.log('1. Project hygiene')
await ensureProjectHygiene()
console.log('\n2. Data management descriptions')
await describeDefinitions()
console.log('\n3. Dashboards')
await ensureDashboards()
console.log(`\nDone. Dashboards: ${HOST}/project/${PROJECT}/dashboard\n`)
