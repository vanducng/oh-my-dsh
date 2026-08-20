/**
 * 80x30 VT cell-grid helper for TUI smoke. Feeds PTY bytes into
 * `@xterm/headless` and exposes the rendered screen, not raw ANSI.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import xterm from '@xterm/headless'

const { Terminal } = xterm
const require = createRequire(import.meta.url)
const pty = require('node-pty')

export const COLS = 80
export const ROWS = 30
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const SNAPSHOT_DIR = fileURLToPath(new URL('./tui-grid-snapshots/', import.meta.url))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One `@xterm/headless` screen of fixed size. */
export class HeadlessGrid {
  constructor({ cols = COLS, rows = ROWS } = {}) {
    this.cols = cols
    this.rows = rows
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    })
    this.#writes = Promise.resolve()
  }

  #writes

  /** Append VT bytes and wait until the emulator has applied them. */
  write(data) {
    const chunk = typeof data === 'string' ? data : String(data)
    this.#writes = this.#writes.then(() => new Promise((resolve) => {
      this.term.write(chunk, resolve)
    }))
    return this.#writes
  }

  async flush() {
    await this.#writes
  }

  /**
   * Viewport rows as plain text. `trimRight` drops trailing spaces so snapshots stay readable.
   * @param {{ trimRight?: boolean }} [options]
   */
  lines({ trimRight = true } = {}) {
    const buffer = this.term.buffer.active
    const rows = []
    for (let y = 0; y < this.rows; y += 1) {
      rows.push(buffer.getLine(y)?.translateToString(trimRight, 0, this.cols) ?? '')
    }
    return rows
  }

  text(options) {
    return this.lines(options).join('\n')
  }

  dispose() {
    this.term.dispose()
  }
}

/** Lines from the first match of `start` through the bottom of the grid. */
export function gridFrom(text, start) {
  const lines = text.replace(/\n$/u, '').split('\n')
  const index = lines.findIndex((line) => line.includes(start))
  if (index < 0) throw new Error(`grid region ${JSON.stringify(start)} not found\n${text}`)
  return lines.slice(index).join('\n')
}

/** Last `count` rendered rows. */
export function lastRows(text, count) {
  const lines = text.replace(/\n$/u, '').split('\n')
  return lines.slice(-count).join('\n')
}

/** Replace run-specific paths so committed grids stay reviewable. */
export function normalizeGrid(text, replacements = {}) {
  let next = text.replaceAll('\r', '')
  const pairs = Object.entries(replacements)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .sort((a, b) => b[1].length - a[1].length)
  for (const [token, value] of pairs) {
    next = next.split(value).join(token)
  }
  return next
}

/** Unified-style line diff for snapshot mismatches. */
export function gridDiff(expected, actual) {
  const left = expected.replace(/\n$/u, '').split('\n')
  const right = actual.replace(/\n$/u, '').split('\n')
  const count = Math.max(left.length, right.length)
  const lines = []
  for (let i = 0; i < count; i += 1) {
    const a = left[i] ?? ''
    const b = right[i] ?? ''
    if (a === b) lines.push(` ${a}`)
    else {
      if (left[i] !== undefined) lines.push(`-${a}`)
      if (right[i] !== undefined) lines.push(`+${b}`)
    }
  }
  return lines.join('\n')
}

/**
 * Compare a normalized grid with a committed snapshot.
 * Set `OMDSH_UPDATE_TUI_SNAPSHOTS=1` to rewrite the file.
 */
export function compareSnapshot(name, actual) {
  const path = join(SNAPSHOT_DIR, name)
  const body = actual.endsWith('\n') ? actual : actual + '\n'
  if (process.env.OMDSH_UPDATE_TUI_SNAPSHOTS === '1') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    return { path, updated: true, ok: true }
  }
  let expected
  try {
    expected = readFileSync(path, 'utf8')
  } catch {
    return { path, ok: false, missing: true, actual: body }
  }
  if (expected === body) return { path, ok: true }
  return { path, ok: false, expected, actual: body, diff: gridDiff(expected, body) }
}

/**
 * Spawn omdsh under node-pty and keep an 80x30 cell grid in sync.
 * @param {{
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   cols?: number,
 *   rows?: number,
 * }} options
 */
export function spawnGridSession(options) {
  const cols = options.cols ?? COLS
  const rows = options.rows ?? ROWS
  const grid = new HeadlessGrid({ cols, rows })
  const spawnCmd = process.env.OMDSH_RUN_MODE === 'built'
    ? [process.execPath, [join(REPO_ROOT, 'apps/omdsh/lib/bin.js')]]
    : [process.execPath, [
      require.resolve('tsx/cli', { paths: [join(REPO_ROOT, 'apps/omdsh'), REPO_ROOT] }),
      join(REPO_ROOT, 'apps/omdsh/src/bin.ts'),
    ]]
  const term = pty.spawn(spawnCmd[0], spawnCmd[1], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: options.cwd,
    env: options.env,
  })

  let lastWrite = Date.now()
  let exitCode = null
  const pending = []

  term.onData((data) => {
    lastWrite = Date.now()
    pending.push(grid.write(data))
  })
  term.onExit(({ exitCode: code }) => {
    exitCode = code
  })

  async function settle() {
    await Promise.all(pending.splice(0, pending.length))
    await grid.flush()
  }

  return {
    grid,
    term,
    get exitCode() { return exitCode },
    write(keys) {
      term.write(keys)
    },
    async waitStable(ms = 250) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await settle()
        if (Date.now() - lastWrite >= ms) return
        await sleep(40)
      }
      throw new Error('screen did not become stable')
    },
    async waitFor(predicate, label, { timeout = 45_000, stableMs = 200 } = {}) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        await settle()
        const screen = grid.text()
        if (predicate(screen, grid.lines())) {
          if (stableMs <= 0) return screen
          if (Date.now() - lastWrite >= stableMs) return screen
        }
        await sleep(40)
      }
      throw new Error(`timed out waiting for ${label}\n${grid.text()}`)
    },
    async capture() {
      await settle()
      return grid.text()
    },
    dispose() {
      try { term.kill() } catch { /* already gone */ }
      grid.dispose()
    },
  }
}
