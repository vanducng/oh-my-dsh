import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function execute(command, args, cwd = root) {
  return spawnSync(command, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
}

function run(command, args, cwd = root) {
  const result = execute(command, args, cwd)
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status ?? 'unknown'}: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

function executable(prefix, name) {
  return process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name)
}

try {
  run('pnpm', ['--filter', '@vanducng/dsh-tui', 'pack', '--pack-destination', temp])
  run('pnpm', ['--filter', '@vanducng/oh-my-dsh', 'pack', '--pack-destination', temp])

  const cliVersion = JSON.parse(readFileSync(join(root, 'apps/omdsh/package.json'), 'utf8')).version
  const tuiTarball = join(temp, `vanducng-dsh-tui-${cliVersion}.tgz`)
  const cliTarball = join(temp, `vanducng-oh-my-dsh-${cliVersion}.tgz`)
  const prefix = join(temp, 'install')

  run('npm', ['install', '--ignore-scripts', '--global', '--prefix', prefix, tuiTarball, cliTarball], temp)

  const listing = run('tar', ['-tf', cliTarball])
  if (!listing.includes('package/lib/bin.js') || !listing.includes('package/config/cordis.yml')) {
    throw new Error('CLI tarball is missing lib/bin.js or config/cordis.yml')
  }

  const packedManifest = JSON.parse(run('tar', ['-xOf', cliTarball, 'package/package.json']))
  const tuiDep = packedManifest.dependencies?.['@vanducng/dsh-tui']
  if (typeof tuiDep !== 'string' || tuiDep.includes('workspace:')) {
    throw new Error(`packed CLI still depends on workspace TUI: ${String(tuiDep)}`)
  }

  const bin = executable(prefix, 'omdsh')
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

  console.log(`packed CLI ${cliVersion} with @vanducng/dsh-tui@${tuiDep}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
