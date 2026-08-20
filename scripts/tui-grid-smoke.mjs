#!/usr/bin/env node
/**
 * Full-screen TUI smoke: node-pty + `@xterm/headless` 80x30 grid.
 * Uses the published mock LLM. Does not call cliproxy.
 *
 * Run: node scripts/tui-grid-smoke.mjs
 * Update snapshots: OMDSH_UPDATE_TUI_SNAPSHOTS=1 node scripts/tui-grid-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { compareSnapshot, gridFrom, lastRows, normalizeGrid, spawnGridSession } from './tui-grid.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const workspace = mkdtempSync(join(tmpdir(), 'omdsh-tui-grid-ws-'))
const home = mkdtempSync(join(tmpdir(), 'omdsh-tui-grid-home-'))
const editorMarker = join(home, 'editor-invoked')
process.on('exit', () => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

mkdirSync(join(workspace, 'src'))
writeFileSync(join(workspace, 'README.md'), 'grid fixture\n')
writeFileSync(join(workspace, 'src/index.ts'), 'export {}\n')
writeFileSync(join(home, 'settings.yaml'), 'agent-presets:\n  default: code\n')
writeFileSync(join(home, 'editor.sh'), [
  '#!/bin/sh',
  `printf grid-edited > "$1"`,
  `printf invoked > "${editorMarker}"`,
  '',
].join('\n'), { mode: 0o755 })

execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: workspace })
execFileSync('git', ['add', 'README.md', 'src/index.ts'], { cwd: workspace })
execFileSync('git', ['-c', 'user.name=omdsh', '-c', 'user.email=omdsh@localhost', 'commit', '--quiet', '-m', 'fixture'], { cwd: workspace })

const server = await startMockLlmServer({
  port: 18123,
  sequence: ['success'],
  successText: 'hello from omdsh grid',
  chunkSize: 8,
  chunkDelayMs: 10,
})

const childEnv = {
  ...process.env,
  OMDSH_HOME: home,
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:18123/v1',
  DEEPSEEK_API_KEY: 'sk-mock',
  NO_COLOR: '1',
  EDITOR: join(home, 'editor.sh'),
  VISUAL: join(home, 'editor.sh'),
  TERM: 'xterm-256color',
}

const session = spawnGridSession({ cwd: workspace, env: childEnv })
const replacements = { $WORKSPACE: workspace, $HOME: home }
let failed = false

function screenTokens(text, tokens) {
  const missing = tokens.filter((token) => !text.includes(token))
  if (missing.length > 0) {
    throw new Error(`grid missing ${missing.map(JSON.stringify).join(', ')}\n${text}`)
  }
}

function snapshot(name, text) {
  const result = compareSnapshot(name, normalizeGrid(text, replacements))
  if (result.updated) {
    console.log(`SNAPSHOT_UPDATED ${name}`)
    return
  }
  if (result.missing) {
    failed = true
    console.error(`FAIL: missing snapshot ${result.path}`)
    console.error(result.actual)
    return
  }
  if (!result.ok) {
    failed = true
    console.error(`FAIL: snapshot ${name}`)
    console.error(result.diff)
  }
}

try {
  const boot = await session.waitFor(
    (text) => text.includes('Into the Unknown') && /deepseek-v4-flash · (?:off|low|high|max)/u.test(text) && text.includes('🐳'),
    'boot header, model footer, and composer',
  )
  screenTokens(boot, ['Into the Unknown', '🐳'])
  snapshot('boot-footer.txt', lastRows(boot, 8))
  console.log('PASS boot + footer/status')

  session.write('/agent\r')
  const agent = await session.waitFor(
    (text) => text.includes('Choose the Agent composition for this blank session') && text.includes('PTC'),
    'Agent selector',
  )
  screenTokens(agent, ['Choose the Agent composition for this blank session', 'PTC', 'Standard', 'Minimal'])
  snapshot('agent-selector.txt', gridFrom(agent, '╭─── Agent'))
  session.write('\x1b')
  const ptc = await session.waitFor(
    (text) => !text.includes('Choose the Agent composition for this blank session') && /ptc · code/u.test(text),
    'PTC footer after closing the Agent selector',
  )
  screenTokens(ptc, ['ptc · code'])
  snapshot('agent-ptc-footer.txt', lastRows(ptc, 8))
  console.log('PASS /agent PTC')

  session.write('/tool-mode\r')
  const tools = await session.waitFor(
    (text) => text.includes('Choose how tools are exposed to the model') && text.includes('Both'),
    'Tools selector',
  )
  screenTokens(tools, ['Choose how tools are exposed to the model', 'Native', 'Code', 'Both'])
  snapshot('tools-selector.txt', gridFrom(tools, '╭─── Tools'))
  session.write('\x1b[B\r')
  const both = await session.waitFor((text) => text.includes('Tools: Both'), 'Both tool presentation')
  screenTokens(both, ['Tools: Both'])
  console.log('PASS /tool-mode Both')

  session.write('@')
  const listing = await session.waitFor(
    (text) => text.includes('README.md') || text.includes('src/'),
    '@ listing popup',
  )
  if (!listing.includes('README.md') && !listing.includes('src/')) {
    throw new Error(`@ listing popup missing fixture paths\n${listing}`)
  }
  snapshot('at-file-listing.txt', lastRows(listing, 10))

  // Debounce is 100ms. Capture the grid during that window so the listing
  // must still be the previous popup, not a blanked composer.
  session.write('z')
  const pendingDeadline = Date.now() + 80
  let pending = ''
  while (Date.now() < pendingDeadline) {
    pending = await session.capture()
    if ((pending.includes('README.md') || pending.includes('src/')) && pending.includes('@z')) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!(pending.includes('README.md') || pending.includes('src/'))) {
    throw new Error(`@ popup closed while search was pending\n${pending}`)
  }
  snapshot('at-file-pending.txt', lastRows(pending, 10))
  console.log('PASS @-file popup stays open while search is pending')

  session.write('\x15') // Ctrl+U clears the composer token
  await session.waitStable(150)

  session.write('\x07') // Ctrl+G
  const edited = await session.waitFor(
    (text) => text.includes('grid-edited'),
    'Ctrl+G external editor round-trip',
  )
  screenTokens(edited, ['grid-edited'])
  snapshot('ctrl-g-editor.txt', lastRows(edited, 8))
  console.log('PASS Ctrl+G open-in-editor')

  session.write('\x03')
  await new Promise((resolve) => setTimeout(resolve, 100))
  session.write('\x03')
  await session.waitFor(() => session.exitCode !== null, 'clean exit', { timeout: 20_000, stableMs: 0 })
} catch (error) {
  failed = true
  console.error(error instanceof Error ? error.message : error)
} finally {
  session.dispose()
  await server.close()
}

if (failed || session.exitCode !== 0) {
  console.error(`TUI_GRID_SMOKE_FAIL exit=${session.exitCode}`)
  process.exit(1)
}
console.log('TUI_GRID_SMOKE_PASS exit=' + session.exitCode)
