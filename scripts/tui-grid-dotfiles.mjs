/**
 * Materialize a sanitized copy of the public vanducng/dotfiles dsh home into
 * a temp OMDSH_HOME. Fetches via gh or raw GitHub. Never writes those files
 * into this repository. Never prints secret values.
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DOTFILES_REPO = 'vanducng/dotfiles'
export const DOTFILES_REF = 'main'

/** Files copied into the temp Harness home (paths relative to repo root). */
export const DOTFILES_DSH_FILES = Object.freeze([
  'dotfiles/dsh/.dsh/settings.yaml',
  'dotfiles/dsh/.dsh/AGENTS.md',
  'dotfiles/dsh/.dsh/omdsh/keybindings.json',
  'dotfiles/dsh/.dsh/omdsh/package.json',
  'dotfiles/dsh/.dsh/omdsh/plugins.yml',
  'dotfiles/dsh/.dsh/profiles/dsh-tui/cordis.patch.yml',
  'dotfiles/dsh/.dsh/profiles/headless/cordis.patch.yml',
  'dotfiles/dsh/.dsh/profiles/web/cordis.patch.yml',
])

const SECRET_ENV_NAMES = [
  'CLI_PROXY_BASE_URL',
  'CLI_PROXY_API_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'ZAI_CODING_CN_API_KEY',
]

/** Replace secret values with `$NAME` so failure logs stay safe. */
export function redactSecrets(text, env = process.env) {
  let next = String(text ?? '')
  const pairs = SECRET_ENV_NAMES
    .map((name) => [name, env[name]])
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of pairs) next = next.split(value).join('$' + name)
  return next.replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-redacted')
}

/**
 * Strip literal credentials and point cliproxyapi at the injected proxy base.
 * `apiKeyEnv` names stay; values never do.
 */
export function sanitizeDotfilesSettings(yaml, { cliproxyBaseUrl } = {}) {
  const lines = String(yaml).split('\n')
  let inCliproxy = false
  let cliproxyIndent = 0
  const out = []
  for (const line of lines) {
    const key = /^(\s*)([^:#\s][^:]*):/u.exec(line)
    if (key !== null) {
      const indent = key[1].length
      const name = key[2].trim()
      if (name === 'cliproxyapi') {
        inCliproxy = true
        cliproxyIndent = indent
      } else if (inCliproxy && indent <= cliproxyIndent) {
        inCliproxy = false
      }
    }
    let next = line
    if (/^\s*(apiKey|secretKey|password|authorization):/iu.test(next) && !/apiKeyEnv:/iu.test(next)) {
      next = next.replace(/:\s*.*$/u, ': ""')
    }
    next = next.replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-redacted')
    if (inCliproxy && /^\s*baseURL:/u.test(next) && typeof cliproxyBaseUrl === 'string' && cliproxyBaseUrl !== '') {
      const indent = next.match(/^\s*/u)?.[0] ?? ''
      const base = cliproxyBaseUrl.replace(/\/+$/u, '')
      next = `${indent}baseURL: ${base.endsWith('/v1') ? base : `${base}/v1`}`
    }
    out.push(next)
  }
  return out.join('\n')
}

function hasGh() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' })
  return result.status === 0
}

async function fetchDotfile(repoPath) {
  if (hasGh()) {
    const result = spawnSync(
      'gh',
      ['api', `repos/${DOTFILES_REPO}/contents/${repoPath}?ref=${DOTFILES_REF}`, '--jq', '.content'],
      { encoding: 'utf8', timeout: 30_000 },
    )
    if (result.status === 0 && result.stdout.trim() !== '') {
      return Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
    }
  }
  const response = await fetch(
    `https://raw.githubusercontent.com/${DOTFILES_REPO}/${DOTFILES_REF}/${repoPath}`,
    { signal: AbortSignal.timeout(20_000) },
  )
  if (!response.ok) {
    throw new Error(`${repoPath} HTTP ${response.status}`)
  }
  return await response.text()
}

function homeRelative(repoPath) {
  return repoPath.replace(/^dotfiles\/dsh\/\.dsh\//u, '')
}

/**
 * Fetch, sanitize, and write Duc's dsh home into `home`.
 * Installs `dsh-observe` from the copied omdsh package.json.
 */
export async function materializeDotfilesHome(home, { cliproxyBaseUrl, env = process.env } = {}) {
  const copied = []
  for (const repoPath of DOTFILES_DSH_FILES) {
    const body = await fetchDotfile(repoPath)
    const relative = homeRelative(repoPath)
    const dest = join(home, relative)
    mkdirSync(dirname(dest), { recursive: true })
    const written = relative === 'settings.yaml'
      ? sanitizeDotfilesSettings(body, { cliproxyBaseUrl })
      : body
    writeFileSync(dest, written)
    copied.push(repoPath)
  }
  const pluginDir = join(home, 'omdsh')
  // pnpm avoids npm 10 arborist crashing on dsh-observe 0.1.1's peer set.
  const install = spawnSync(
    'pnpm',
    ['install', '--ignore-scripts', '--prod'],
    { cwd: pluginDir, encoding: 'utf8', timeout: 120_000, env },
  )
  if (install.status !== 0) {
    throw new Error(`dsh-observe install failed exit=${install.status} ${redactSecrets(install.stderr || install.stdout, env).slice(0, 400)}`)
  }
  return { copied, pluginDir }
}

function langfuseOrigin(env = process.env) {
  const raw = env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/u, '')
}

function basicAuth(env = process.env) {
  return Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`, 'utf8').toString('base64')
}

/** Record one Langfuse trace without printing host or credential values. */
export async function recordDotfilesTrace({ name, ok, input, output, env = process.env }) {
  const origin = langfuseOrigin(env)
  if (origin === undefined || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    return { skipped: true, reason: 'LANGFUSE_* unset' }
  }
  const traceId = randomUUID()
  const timestamp = new Date().toISOString()
  const response = await fetch(`${origin}/api/public/ingestion`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      batch: [{
        id: randomUUID(),
        timestamp,
        type: 'trace-create',
        body: {
          id: traceId,
          name,
          sessionId: 'omdsh-eval-dotfiles',
          release: 'eval',
          tags: ['oh-my-dsh', 'eval', 'dotfiles-config'],
          environment: 'oh-my-dsh-eval',
          metadata: { env: 'oh-my-dsh-eval', scenario: name },
          input,
          output,
        },
      }],
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`langfuse_ingestion HTTP ${response.status}`)
  }
  return { skipped: false, traceId, ok }
}
