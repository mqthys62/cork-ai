/**
 * One throw-away ~/.cork-ai per test file. Every module reads CORK_AI_HOME
 * when it loads, and this setup runs before the test file's imports — so
 * files running in parallel workers never share state (a live session left
 * by hook.test.ts used to leak into savings.test.ts), and the real
 * ~/.cork-ai is never touched.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll } from 'vitest'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-ai-test-'))
process.env.CORK_AI_HOME = home

afterAll(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
})
