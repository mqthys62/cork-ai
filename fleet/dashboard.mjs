#!/usr/bin/env node
/**
 * Fleet dashboard — reads the reports your workstations wrote, serves a page.
 *
 *   node dashboard.mjs --reports /mnt/fleet-reports
 *   node dashboard.mjs --reports ./reports --ingest --token "$FLEET_TOKEN"
 *
 * There is no PostHog key here, and no account anywhere: this reads JSON files
 * produced by collect.mjs and nothing else. It never talks to cork-ai's own
 * telemetry — that channel is anonymous, opt-in, and belongs to cork-ai's
 * author, not to you.
 *
 * Binds to 127.0.0.1 by default. Serving a fleet means --host 0.0.0.0, and
 * then you own what that exposes: put it behind your own auth, on your own
 * network. `--ingest` opens POST /ingest so workstations can deliver reports
 * over HTTP instead of a shared folder; with --token, a request without that
 * bearer is refused.
 *
 * Node >= 18. No dependencies.
 */

import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = name => process.argv.includes(`--${name}`)

if (has('help')) {
  console.log(`
  cork-ai fleet dashboard — reads reports from a folder, serves a page.

    node dashboard.mjs --reports <folder>      read reports from here
    node dashboard.mjs --reports <folder> --ingest [--token <t>]
                                               also accept POST /ingest

  Options
    --port <n>        default 4343
    --host <addr>     default 127.0.0.1 (use 0.0.0.0 to serve the network —
                      put your own authentication in front of it)
    --labels <file>   names for the machines (default: <reports>/labels.json)

  No PostHog key. No account. Reads JSON files, nothing else.
`)
  process.exit(0)
}

const REPORTS = path.resolve(arg('reports', './reports'))
const PORT = Number(arg('port', 4343))
const HOST = arg('host', '127.0.0.1')
const TOKEN = arg('token', process.env.FLEET_TOKEN)
const INGEST = has('ingest')
const LABELS_FILE = path.resolve(arg('labels', path.join(REPORTS, 'labels.json')))
const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html')

// ─── reading the fleet ───────────────────────────────────────────────────────

/**
 * Every report in the folder. A file that is unreadable or half-written is
 * skipped and reported, never fatal: on a network share a collector may be
 * mid-write while we read, and the next run repairs it.
 */
function readReports() {
  let files = []
  try { files = fs.readdirSync(REPORTS).filter(f => f.endsWith('.json') && f !== path.basename(LABELS_FILE)) }
  catch { return { reports: [], unreadable: [], missingFolder: true } }

  const reports = []
  const unreadable = []
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf-8'))
      if (!r?.machine?.key) { unreadable.push({ file: f, why: 'not a fleet report' }); continue }
      r.file = f
      r.fileModified = fs.statSync(path.join(REPORTS, f)).mtime.toISOString()
      reports.push(r)
    } catch (err) { unreadable.push({ file: f, why: String(err.message ?? err).slice(0, 120) }) }
  }
  return { reports, unreadable, missingFolder: false }
}

const readLabels = () => { try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf-8')) } catch { return {} } }
function writeLabels(labels) {
  fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true })
  const tmp = `${LABELS_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n')
  fs.renameSync(tmp, LABELS_FILE)
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Rolls the fleet up. Deliberately arithmetic on what the reports contain —
 * no modelling, no estimation: every number here is a sum or a count of
 * numbers a workstation actually reported.
 */
function summarise(reports) {
  const now = Date.now()
  const machines = reports.map(r => {
    const s = r.report?.summary ?? {}
    const sessions = r.report?.sessions ?? []
    const last = sessions.reduce((m, x) => (x.endedAt && x.endedAt > m ? x.endedAt : m), '')
    return {
      key: r.machine.key,
      installId: r.machine.installId ?? null,
      hostname: r.machine.hostname ?? null,
      user: r.machine.user ?? null,
      environment: r.machine.environment ?? r.machine.platform ?? null,
      version: r.cork?.version ?? null,
      autoCompactWindow: r.cork?.autoCompactWindow ?? null,
      telemetry: r.cork?.telemetry ?? null,
      privacy: r.privacy ?? 'default',
      generatedAt: r.generatedAt,
      fileModified: r.fileModified,
      staleDays: r.generatedAt ? Math.floor((now - new Date(r.generatedAt).getTime()) / 86_400_000) : null,
      sessions: sessions.length,
      lastSessionAt: last || null,
      requests: num(s.totalRequests),
      originalTokens: num(s.totalOriginalTokens),
      savedTokens: num(s.totalSavedTokens),
      costSaved: num(s.estimatedCostSaved),
      rereads: num(s.reReads),
      rereadTokens: num(s.reReadTokensServed),
      projects: (r.report?.projects ?? []).length,
    }
  }).sort((a, b) => (b.savedTokens - a.savedTokens))

  const sum = k => machines.reduce((t, m) => t + m[k], 0)
  const versions = {}
  for (const m of machines) if (m.version) versions[m.version] = (versions[m.version] ?? 0) + 1
  const envs = {}
  for (const m of machines) if (m.environment) envs[m.environment] = (envs[m.environment] ?? 0) + 1

  // Projects across the fleet, when reports carry names at all.
  const projects = {}
  for (const r of reports) {
    for (const p of r.report?.projects ?? []) {
      const name = p.projectName
      if (!name) continue
      const e = projects[name] ??= { project: name, machines: 0, sessions: 0, savedTokens: 0, costSaved: 0 }
      e.machines += 1
      e.sessions += num(p.sessionCount)
      e.savedTokens += num(p.totalSavedTokens)
      e.costSaved += num(p.totalCostSaved)
    }
  }

  // Daily trend, merged across machines by date label.
  const daily = {}
  for (const r of reports) {
    for (const d of r.report?.trends?.daily ?? []) {
      if (!d.label) continue
      const e = daily[d.label] ??= { day: d.label, sessions: 0, savedTokens: 0, originalTokens: 0, costSaved: 0 }
      e.sessions += num(d.sessionCount)
      e.savedTokens += num(d.totalSavedTokens)
      e.originalTokens += num(d.totalOriginalTokens)
      e.costSaved += num(d.totalCostSaved)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    reportsFolder: REPORTS,
    machines,
    totals: {
      machines: machines.length,
      sessions: sum('sessions'),
      requests: sum('requests'),
      originalTokens: sum('originalTokens'),
      savedTokens: sum('savedTokens'),
      costSaved: Math.round(sum('costSaved') * 100) / 100,
      rereads: sum('rereads'),
      savedPct: sum('originalTokens') > 0 ? Math.round((sum('savedTokens') / sum('originalTokens')) * 1000) / 10 : 0,
      rereadRate: sum('requests') > 0 ? Math.round((sum('rereads') / sum('requests')) * 1000) / 10 : 0,
      withoutWindow: machines.filter(m => !m.autoCompactWindow).length,
      stale: machines.filter(m => m.staleDays != null && m.staleDays > 7).length,
    },
    versions: Object.entries(versions).sort((a, b) => b[1] - a[1]),
    environments: Object.entries(envs).sort((a, b) => b[1] - a[1]),
    projects: Object.values(projects).sort((a, b) => b.savedTokens - a.savedTokens).slice(0, 40),
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
  }
}

// ─── server ──────────────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)

  if (url.pathname === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(fs.readFileSync(HTML))
    } catch { res.writeHead(500); res.end('dashboard.html missing next to dashboard.mjs') }
    return
  }

  if (url.pathname === '/api/fleet') {
    const { reports, unreadable, missingFolder } = readReports()
    const data = summarise(reports)
    data.unreadable = unreadable
    data.missingFolder = missingFolder
    data.labels = readLabels()
    return json(res, 200, data)
  }

  if (url.pathname === '/api/labels' && (req.method === 'PUT' || req.method === 'POST')) {
    let raw = ''
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) return json(res, 413, { error: 'payload too large' }) }
      const body = JSON.parse(raw || '{}')
      const key = String(body.key ?? '').trim()
      if (!key) return json(res, 400, { error: 'key missing' })
      const labels = readLabels()
      const name = String(body.name ?? '').trim().slice(0, 60)
      const team = String(body.team ?? '').trim().slice(0, 60)
      const note = String(body.note ?? '').trim().slice(0, 500)
      if (!name && !team && !note) delete labels[key]
      else labels[key] = { name, team, note, updatedAt: new Date().toISOString() }
      writeLabels(labels)
      return json(res, 200, labels)
    } catch (err) { return json(res, 400, { error: String(err.message ?? err) }) }
  }

  if (url.pathname === '/ingest' && req.method === 'POST') {
    if (!INGEST) return json(res, 404, { error: 'ingestion disabled — start with --ingest' })
    const auth = req.headers.authorization ?? ''
    if (TOKEN && auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'bad or missing bearer token' })
    let raw = ''
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024 * 1024) return json(res, 413, { error: 'payload too large' }) }
      const payload = JSON.parse(raw)
      const key = payload?.machine?.key
      if (!key || typeof key !== 'string') return json(res, 400, { error: 'machine.key missing' })
      // The key names the file, so it must not be able to name a *path*.
      const safe = key.replace(/[^\w.@-]/g, '_').slice(0, 100)
      fs.mkdirSync(REPORTS, { recursive: true })
      const dest = path.join(REPORTS, `${safe}.json`)
      const tmp = `${dest}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
      fs.renameSync(tmp, dest)
      return json(res, 200, { ok: true, stored: path.basename(dest) })
    } catch (err) { return json(res, 400, { error: String(err.message ?? err) }) }
  }

  res.writeHead(404); res.end('not found')
})

server.listen(PORT, HOST, () => {
  const { reports, unreadable, missingFolder } = readReports()
  console.log(`\n  cork-ai fleet  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`)
  console.log(`  reports: ${REPORTS}${missingFolder ? '  (folder does not exist yet)' : `  — ${reports.length} machine${reports.length === 1 ? '' : 's'}`}`)
  if (unreadable.length) console.log(`  skipped: ${unreadable.length} unreadable file(s)`)
  console.log(`  labels:  ${LABELS_FILE}`)
  console.log(`  ingest:  ${INGEST ? (TOKEN ? 'POST /ingest (bearer token required)' : 'POST /ingest (NO TOKEN — anyone who can reach this port can write reports)') : 'disabled'}`)
  if (HOST === '0.0.0.0') console.log(`\n  ⚠ bound to every interface. Put your own authentication in front of it.`)
  console.log()
})
