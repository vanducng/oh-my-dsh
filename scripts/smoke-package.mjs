import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'omdsh-package-'))
const childEnv = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'CI',
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
)

function execute(command, args, cwd = root, extraEnv = undefined, input = undefined) {
  return spawnSync(command, args, {
    cwd,
    env: extraEnv === undefined ? childEnv : { ...childEnv, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
    timeout: 120_000,
  })
}

function run(command, args, cwd = root) {
  const result = execute(command, args, cwd)
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status ?? 'unknown'}: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

try {
  run('pnpm', ['--filter', '@vanducng/dsh-tui', 'pack', '--pack-destination', temp])
  run('pnpm', ['--filter', '@vanducng/oh-my-dsh', 'pack', '--pack-destination', temp])

  const cliVersion = JSON.parse(readFileSync(join(root, 'apps/omdsh/package.json'), 'utf8')).version
  const tuiTarball = join(temp, `vanducng-dsh-tui-${cliVersion}.tgz`)
  const cliTarball = join(temp, `vanducng-oh-my-dsh-${cliVersion}.tgz`)
  const prefix = join(temp, 'install')
  mkdirSync(prefix, { recursive: true })
  writeFileSync(join(prefix, 'package.json'), JSON.stringify({
    private: true,
    overrides: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/cordis-plugin-include': '1.0.6',
      '@deepseek-ai/cordis-plugin-group': '1.0.1',
    },
  }))

  run('npm', ['install', '--ignore-scripts', '--prefix', prefix, tuiTarball, cliTarball], prefix)

  const listing = run('tar', ['-tf', cliTarball])
  if (!listing.includes('package/lib/bin.js') || !listing.includes('package/config/cordis.yml')) {
    throw new Error('CLI tarball is missing lib/bin.js or config/cordis.yml')
  }

  const packedManifest = JSON.parse(run('tar', ['-xOf', cliTarball, 'package/package.json']))
  const tuiDep = packedManifest.dependencies?.['@vanducng/dsh-tui']
  if (typeof tuiDep !== 'string' || tuiDep.includes('workspace:')) {
    throw new Error(`packed CLI still depends on workspace TUI: ${String(tuiDep)}`)
  }

  const bin = join(prefix, 'node_modules', '.bin', 'omdsh')
  const help = execute(bin, ['--help'], temp)
  if (help.status !== 0 || !help.stdout.includes('omdsh')) {
    throw new Error(`omdsh --help failed: ${(help.stderr || help.stdout).trim()}`)
  }
  const version = execute(bin, ['--version'], temp)
  if (version.status !== 0 || version.stdout.trim() !== cliVersion) {
    throw new Error(`omdsh --version failed: ${(version.stderr || version.stdout).trim()}`)
  }
  const unknown = execute(bin, ['--not-a-real-flag'], temp)
  if (unknown.status === 0) {
    throw new Error('omdsh accepted an unknown flag')
  }

  // Bare plugin names outside the app need the loader's native helper, which the packed install must ship.
  const home = join(temp, 'dsh-home')
  const pluginDir = join(home, 'omdsh', 'node_modules', 'omdsh-smoke-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'omdsh-smoke-plugin', type: 'module', main: './index.js' }))
  writeFileSync(join(pluginDir, 'index.js'), [
    "import { writeFileSync } from 'node:fs'",
    "export const name = 'omdsh-smoke-plugin'",
    'export function apply() {',
    "  writeFileSync(process.env.OMDSH_SMOKE_PLUGIN_OUT, 'mounted')",
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(home, 'omdsh', 'plugins.yml'), '- id: smoke-plugin\n  name: omdsh-smoke-plugin\n')
  const marker = join(temp, 'smoke-plugin-mounted')
  const boot = execute(bin, [], temp, {
    OMDSH_HOME: home,
    DEEPSEEK_API_KEY: 'sk-mock',
    OMDSH_SMOKE_PLUGIN_OUT: marker,
    NO_COLOR: '1',
  }, '')
  if (boot.status !== 0 || !existsSync(marker)) {
    throw new Error(`packed bin failed to mount a user plugin by bare name: exit ${boot.status}: ${(boot.stderr || boot.stdout).slice(-800)}`)
  }

  console.log(`packed CLI ${cliVersion} with @vanducng/dsh-tui@${tuiDep}; user plugin mounted`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
