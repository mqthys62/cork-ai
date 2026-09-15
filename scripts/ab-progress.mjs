#!/usr/bin/env node
/**
 * Terminal progress for the A/B harnesses.
 *
 * Shared by the measurement run and the blind grading, which both block for
 * minutes at a time inside `spawnSync` and would otherwise print nothing.
 */
import { spawn } from 'child_process'

/**
 * A live "still working" line during a run.
 *
 * `spawnSync` blocks this process completely, so a setInterval here would
 * never fire. The ticker therefore runs in a detached child that owns the
 * terminal line until the run returns. Purely cosmetic -- and load-bearing
 * anyway, because a terminal that prints nothing for seven minutes looks
 * broken, and killing it would discard a run that was already paid for.
 */
export function startTicker(label) {
  if (!process.stdout.isTTY) return null
  const child = spawn(process.execPath, ['-e', `
    const label = process.argv[1]
    const started = Date.now()
    const frames = ['|', '/', '-', '\\\\']
    let i = 0
    setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000)
      const m = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
      process.stdout.write('\\r' + label + ' ' + frames[i++ % 4] + ' running ' + m)
    }, 250)
    // If the parent dies, do not linger: a stray ticker would keep writing
    // over a terminal whose run ended long ago.
    setTimeout(() => process.exit(0), 30 * 60_000).unref()
  `, label], { stdio: ['ignore', 'inherit', 'ignore'], detached: false })
  // Do not let a running ticker hold the process open at exit.
  child.unref()
  return child
}

export function stopTicker(child) {
  if (!child) return
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  // Wipe the ticker's line so the result overwrites it cleanly.
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(Math.min(process.stdout.columns || 100, 160)) + '\r')
}

/** Rough time left, from the average run so far. Honest, not precise. */
export function etaFor(t0, doneCount, total) {
  if (doneCount < 2 || doneCount >= total) return ''
  const perRun = (Date.now() - t0) / doneCount
  const left = Math.round(perRun * (total - doneCount) / 60000)
  return left > 0 ? `  ~${left}min left` : ''
}
