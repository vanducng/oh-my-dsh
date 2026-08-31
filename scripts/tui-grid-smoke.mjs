#!/usr/bin/env node
/**
 * Full-screen TUI smoke: node-pty + `@xterm/headless` 80x30 grid.
 * Deterministic scenarios use the published mock LLM. One extra boot loads a
 * sanitized copy of vanducng/dotfiles dsh settings (not committed here).
 *
 * Run: node scripts/tui-grid-smoke.mjs
 * Update snapshots: OMDSH_UPDATE_TUI_SNAPSHOTS=1 node scripts/tui-grid-smoke.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { materializeDotfilesHome, recordDotfilesTrace, redactSecrets } from './tui-grid-dotfiles.mjs'
import { compareSnapshot, gridFrom, lastRows, normalizeGrid, REPO_ROOT, spawnGridSession } from './tui-grid.mjs'

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'omdsh-tui-grid-ws-')))
const home = realpathSync(mkdtempSync(join(tmpdir(), 'omdsh-tui-grid-home-')))
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
  HOME: dirname(workspace),
  OMDSH_HOME: home,
  DSH_HOME: home,
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:18123/v1',
  DEEPSEEK_API_KEY: 'sk-mock',
  NO_COLOR: '1',
  EDITOR: join(home, 'editor.sh'),
  VISUAL: join(home, 'editor.sh'),
  TERM: 'xterm-256color',
}

const session = spawnGridSession({ cwd: workspace, env: childEnv })
const replacements = { $WORKSPACE: `~/${basename(workspace)}`, $HOME: home }
let failed = false

function screenTokens(text, tokens) {
  const missing = tokens.filter((token) => !text.includes(token))
  if (missing.length > 0) {
    throw new Error(`grid missing ${missing.map(JSON.stringify).join(', ')}\n${text}`)
  }
}

function snapshot(name, text) {
  const normalized = normalizeGrid(text, replacements)
    .replace(/( · ptc) +(\$WORKSPACE · main)/gu, '$1   $2')
  const result = compareSnapshot(name, normalized)
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
    (text) => text.includes('Into the Unknown')
      && /│\s+high\s+│/u.test(text)
      && /deepseek-v4-flash(?: · high)? · ptc/u.test(text)
      && text.includes('🐳'),
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
    (text) => !text.includes('Choose the Agent composition for this blank session') && /ptc/u.test(text),
    'PTC footer after closing the Agent selector',
  )
  screenTokens(ptc, ['ptc'])
  snapshot('agent-ptc-footer.txt', lastRows(ptc, 8))
  console.log('PASS /agent PTC')

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

const require = createRequire(import.meta.url)

async function runDotfilesBoot() {
  const home = mkdtempSync(join(tmpdir(), 'omdsh-tui-grid-dotfiles-'))
  const workspace = mkdtempSync(join(tmpdir(), 'omdsh-tui-grid-dotfiles-ws-'))
  process.on('exit', () => {
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'README.md'), 'dotfiles fixture\n')
  writeFileSync(join(workspace, 'src/index.ts'), 'export {}\n')
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: workspace })
  execFileSync('git', ['add', 'README.md', 'src/index.ts'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=omdsh', '-c', 'user.email=omdsh@localhost', 'commit', '--quiet', '-m', 'fixture'], { cwd: workspace })

  const cliproxyBaseUrl = process.env.CLI_PROXY_BASE_URL
  const materialized = await materializeDotfilesHome(home, { cliproxyBaseUrl })
  console.log('DOTFILES_PATHS ' + materialized.copied.join(' '))

  const childEnv = {
    ...process.env,
    OMDSH_HOME: home,
    DSH_HOME: home,
    NO_COLOR: '1',
    TERM: 'xterm-256color',
  }
  delete childEnv.OMDSH_MODEL
  delete childEnv.OMDSH_PROVIDER
  delete childEnv.DEEPSEEK_BASE_URL
  delete childEnv.DEEPSEEK_API_KEY

  const tsx = require.resolve('tsx/cli', { paths: [join(REPO_ROOT, 'apps/omdsh'), REPO_ROOT] })
  const dump = spawnSync(process.execPath, [tsx, join(REPO_ROOT, 'apps/omdsh/src/bin.ts'), '--dump-config'], {
    cwd: workspace,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const dumpText = dump.stdout + dump.stderr
  if (dump.status !== 0) {
    throw new Error(`dotfiles --dump-config exit=${dump.status} ${redactSecrets(dumpText).slice(0, 800)}`)
  }
  for (const marker of ['omdsh-user-plugins', 'omdsh/plugins.yml', 'id: llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai']) {
    if (!dumpText.includes(marker)) {
      throw new Error(`dotfiles dump missing ${marker}`)
    }
  }
  if (!existsSync(join(home, 'omdsh/node_modules/dsh-observe'))) {
    throw new Error('dotfiles home missing omdsh/node_modules/dsh-observe')
  }
  console.log('PASS dotfiles plugin mount (omdsh-user-plugins include, dsh-observe installed, llm-pi-ai)')

  const grokRe = /grok-4\.6|Grok 4\.6/u
  const asIs = spawnGridSession({ cwd: workspace, env: childEnv })
  let live = asIs
  try {
    const asIsScreen = await asIs.waitFor(
      (text) => text.includes('Into the Unknown') && text.includes('🐳') && grokRe.test(text),
      'dotfiles as-is boot footer with grok-4.6',
      { timeout: 25_000 },
    )
    if (!grokRe.test(asIsScreen) || !asIsScreen.includes('🐳')) {
      throw new Error(`dotfiles as-is boot missing grok-4.6 with plugins.yml mounted\n${redactSecrets(lastRows(asIsScreen, 12))}`)
    }
    console.log('PASS dotfiles as-is boot footer/model')

    const bootTrace = await recordDotfilesTrace({
      name: 'dotfiles-config-boot',
      ok: true,
      input: { paths: materialized.copied },
      output: { boot: true, model: 'grok-4.6', pluginsYml: true },
    })
    if (!bootTrace.skipped) console.log(`TRACE dotfiles-config-boot id=${bootTrace.traceId}`)

    const canLive = Boolean(process.env.CLI_PROXY_BASE_URL && process.env.CLI_PROXY_API_KEY)
    if (!canLive) {
      console.log('SKIP dotfiles live cliproxy turn (CLI_PROXY_* unset)')
      live.write('\x03')
      await new Promise((resolve) => setTimeout(resolve, 100))
      live.write('\x03')
      await live.waitFor(() => live.exitCode !== null, 'dotfiles clean exit', { timeout: 20_000, stableMs: 0 })
      return
    }

    const livePrompt = 'Reply with only: dotfiles-pong'
    try {
      live.write(livePrompt + '\r')
      const reply = await live.waitFor(
        (text) => text.replace(livePrompt, '').includes('dotfiles-pong'),
        'dotfiles cliproxy reply',
        { timeout: 90_000 },
      )
      if (!reply.replace(livePrompt, '').includes('dotfiles-pong')) {
        throw new Error('dotfiles live turn produced no pong')
      }
      console.log('PASS dotfiles live cliproxy turn')
      const traced = await recordDotfilesTrace({
        name: 'dotfiles-config-live-turn',
        ok: true,
        input: { model: 'grok-4.6', prompt: livePrompt },
        output: { boot: true, liveTurn: true, pluginsYml: true },
      })
      if (!traced.skipped) console.log(`TRACE dotfiles-config-live-turn id=${traced.traceId}`)
    } catch (error) {
      console.error(redactSecrets(error instanceof Error ? error.message : String(error)))
      console.log('SKIP dotfiles live cliproxy turn (boot still passed)')
      await recordDotfilesTrace({
        name: 'dotfiles-config-live-turn',
        ok: false,
        input: { model: 'grok-4.6', prompt: livePrompt },
        output: { boot: true, liveTurn: 'failed', pluginsYml: true },
      })
    }

    live.write('\x03')
    await new Promise((resolve) => setTimeout(resolve, 100))
    live.write('\x03')
    await live.waitFor(() => live.exitCode !== null, 'dotfiles clean exit', { timeout: 20_000, stableMs: 0 })
  } finally {
    live.dispose()
  }
}

try {
  await runDotfilesBoot()
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
console.log('TUI_GRID_SMOKE_PASS exit=' + session.exitCode)
