#!/usr/bin/env node
/**
 * Eval-only Langfuse tracer for oh-my-dsh. Starts one trace per scenario, with
 * a span or generation around session/profile/plugin load, packed CLI boot, a
 * cliproxy chat completion, and deny/error paths.
 *
 * Reads LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_BASE_URL or
 * LANGFUSE_HOST, CLI_PROXY_BASE_URL, and CLI_PROXY_API_KEY from the process
 * environment. Never prints those values, never writes them to files, and never
 * attaches them to traces.
 *
 * Run: node scripts/eval-langfuse.mjs
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const appRoot = join(root, 'apps/omdsh')
const TAGS = ['oh-my-dsh', 'pr-19', 'env=oh-my-dsh-eval']
const EVAL_ENVIRONMENT = 'oh-my-dsh-eval'
const PREFERRED_MODEL = 'grok-4.6'
const SESSION_ID = `pr-19-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}`
const PACK_ENV_KEYS = [
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
]

function requiredEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is unset`)
  }
  return value
}

function optionalEnv(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function normalizeBase(raw) {
  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

function langfuseHostKind(base) {
  try {
    const host = new URL(base).hostname.toLowerCase()
    if (host === 'us.cloud.langfuse.com' || host.endsWith('.us.cloud.langfuse.com')) return 'us-cloud'
    if (host === 'cloud.langfuse.com' || host.endsWith('.cloud.langfuse.com')) return 'eu-cloud'
    return 'other'
  } catch {
    return 'unparseable'
  }
}

function fetchErrorCode(error) {
  return error?.cause?.code || error?.code || error?.name || 'fetch-failed'
}

function basicAuth(publicKey, secretKey) {
  return Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64')
}

function limitedEnv(extra = {}) {
  return Object.fromEntries([
    ...PACK_ENV_KEYS.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ...Object.entries(extra),
  ])
}

function executable(prefix, name) {
  return process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name)
}

async function request(label, url, init = {}) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
    return { label, status: response.status, ok: response.ok, ms: Date.now() - started, response }
  } catch (error) {
    return { label, status: 0, ok: false, ms: Date.now() - started, error: fetchErrorCode(error) }
  }
}

function failUnreachable(probe) {
  const detail = probe.status === 0 ? `error=${probe.error}` : `HTTP ${probe.status}`
  console.error(`${probe.label} unreachable ${detail} ms=${probe.ms}`)
  process.exit(1)
}

const langfuseBase = normalizeBase(optionalEnv('LANGFUSE_BASE_URL') || requiredEnv('LANGFUSE_HOST'))
const langfusePublic = requiredEnv('LANGFUSE_PUBLIC_KEY')
const langfuseSecret = requiredEnv('LANGFUSE_SECRET_KEY')
const proxyBase = normalizeBase(requiredEnv('CLI_PROXY_BASE_URL'))
const proxyKey = requiredEnv('CLI_PROXY_API_KEY')
const langfuseAuth = basicAuth(langfusePublic, langfuseSecret)
const langfuseHeaders = {
  Authorization: `Basic ${langfuseAuth}`,
  'Content-Type': 'application/json',
}

const health = await request('langfuse_health', `${langfuseBase}/api/public/health`)
if (!health.ok) failUnreachable(health)
const projects = await request('langfuse_projects', `${langfuseBase}/api/public/projects`, { headers: langfuseHeaders })
if (!projects.ok) failUnreachable(projects)
const projectBody = await projects.response.json()
const projectId = projectBody?.data?.[0]?.id
if (typeof projectId !== 'string' || projectId === '') {
  console.error('langfuse_projects HTTP 200 but no project id')
  process.exit(1)
}

const modelsProbe = await request('cliproxy_models', `${proxyBase}/v1/models`, {
  headers: { Authorization: `Bearer ${proxyKey}` },
})
if (!modelsProbe.ok) failUnreachable(modelsProbe)
const modelBody = await modelsProbe.response.json()
const modelIds = (modelBody.data || []).map((row) => row.id).filter((id) => typeof id === 'string')
if (modelIds.length === 0) {
  console.error('cliproxy_models HTTP 200 but the listing is empty')
  process.exit(1)
}

const hostKind = langfuseHostKind(langfuseBase)
console.log(`langfuse_ready status=${health.status} host_kind=${hostKind} projects=${projectBody.data.length}`)
console.log(`cliproxy_ready status=${modelsProbe.status} model_count=${modelIds.length} has_${PREFERRED_MODEL}=${modelIds.includes(PREFERRED_MODEL)}`)
if (hostKind !== 'us-cloud') {
  console.error(`langfuse host_kind=${hostKind}; expected us-cloud`)
  process.exit(1)
}

function tracePath(traceId) {
  return `/project/${projectId}/traces/${traceId}`
}

async function ingest(events) {
  const probe = await request('langfuse_ingestion', `${langfuseBase}/api/public/ingestion`, {
    method: 'POST',
    headers: langfuseHeaders,
    body: JSON.stringify({ batch: events }),
    timeoutMs: 20_000,
  })
  if (!probe.ok) {
    console.error(`langfuse_ingestion HTTP ${probe.status || 0}${probe.error ? ` error=${probe.error}` : ''}`)
    process.exit(1)
  }
  const body = await probe.response.json()
  const errors = Array.isArray(body.errors) ? body.errors : []
  if (errors.length > 0) {
    const statuses = errors.map((row) => row.status ?? row.message ?? 'unknown').join(',')
    console.error(`langfuse_ingestion rejected events statuses=${statuses}`)
    process.exit(1)
  }
  return probe
}

function event(type, body, timestamp = new Date().toISOString()) {
  return { id: randomUUID(), timestamp, type, body }
}

async function finishScenario(scenario) {
  const ended = new Date().toISOString()
  const events = [
    event('trace-create', {
      id: scenario.traceId,
      name: scenario.name,
      sessionId: SESSION_ID,
      release: 'pr-19',
      version: '0.7.1',
      tags: TAGS,
      environment: EVAL_ENVIRONMENT,
      metadata: {
        env: EVAL_ENVIRONMENT,
        scenario: scenario.name,
        repo: 'vanducng/oh-my-dsh',
        branch: 'cursor/sync-upstream-f990',
      },
      input: scenario.input,
      output: scenario.output,
    }),
  ]
  for (const observation of scenario.observations) {
    events.push(
      event(observation.type, {
        id: observation.id,
        traceId: scenario.traceId,
        name: observation.name,
        startTime: observation.startTime,
        endTime: observation.endTime ?? ended,
        input: observation.input,
        output: observation.output,
        level: observation.level ?? 'DEFAULT',
        statusMessage: observation.statusMessage,
        model: observation.model,
        modelParameters: observation.modelParameters,
        usage: observation.usage,
        metadata: observation.metadata,
      }),
    )
  }
  await ingest(events)
  console.log(`TRACE ${scenario.name} id=${scenario.traceId} path=${tracePath(scenario.traceId)} ok=${scenario.ok}`)
  return scenario
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    input: options.input,
  })
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.code || result.error?.message,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function clip(text, limit = 800) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(0, limit) + '…'
}

const scenarios = []

{
  const name = 'session-profile-plugin-load'
  const traceId = randomUUID()
  const home = mkdtempSync(join(tmpdir(), 'omdsh-eval-dump-'))
  const startTime = new Date().toISOString()
  mkdirSync(join(home, 'omdsh'), { recursive: true })
  writeFileSync(join(home, 'omdsh', 'plugins.yml'), '[]\n')
  const dump = run('pnpm', ['exec', 'tsx', 'src/bin.ts', '--dump-config'], {
    cwd: appRoot,
    env: { ...process.env, OMDSH_HOME: home },
    timeout: 60_000,
  })
  const pluginHelp = run('pnpm', ['exec', 'tsx', 'src/bin.ts', 'plugin'], {
    cwd: appRoot,
    env: { ...process.env, OMDSH_HOME: home },
    timeout: 30_000,
  })
  rmSync(home, { recursive: true, force: true })
  const dumpText = dump.stdout
  const markers = {
    productBundle: dumpText.includes('@vanducng/oh-my-dsh'),
    tui: dumpText.includes('@vanducng/dsh-tui'),
    piAiId: dumpText.includes('id: llm-pi-ai') || dumpText.includes('id:llm-pi-ai'),
    piAiPackage: dumpText.includes('@deepseek-ai/dsh-llm-pi-ai'),
    profileLayer: dumpText.includes('profiles/omdsh') || dumpText.includes('profile'),
    userPlugins: dumpText.includes('omdsh/plugins.yml') || dumpText.includes('omdsh-user-plugins'),
    pluginHelp: (pluginHelp.stdout + pluginHelp.stderr).includes('omdsh plugin add'),
  }
  const ok = dump.status === 0 && pluginHelp.status === 0 && markers.productBundle && markers.piAiPackage && markers.pluginHelp
  scenarios.push(
    await finishScenario({
      name,
      traceId,
      ok,
      input: { commands: ['omdsh --dump-config', 'omdsh plugin'] },
      output: { dumpStatus: dump.status, pluginHelpStatus: pluginHelp.status, markers },
      observations: [
        {
          type: 'span-create',
          id: randomUUID(),
          name: 'omdsh --dump-config',
          startTime,
          endTime: new Date().toISOString(),
          input: { argv: ['--dump-config'] },
          output: { status: dump.status, markers, preview: clip(dumpText, 400) },
          level: dump.status === 0 ? 'DEFAULT' : 'ERROR',
          statusMessage: dump.status === 0 ? undefined : clip(dump.stderr, 200),
        },
        {
          type: 'span-create',
          id: randomUUID(),
          name: 'omdsh plugin help',
          startTime,
          endTime: new Date().toISOString(),
          input: { argv: ['plugin'] },
          output: { status: pluginHelp.status, preview: clip(pluginHelp.stdout + pluginHelp.stderr, 400) },
          level: pluginHelp.status === 0 ? 'DEFAULT' : 'ERROR',
        },
      ],
    }),
  )
  if (!ok) console.error(`${name} failed dump=${dump.status} plugin=${pluginHelp.status} markers=${JSON.stringify(markers)}`)
}

{
  const name = 'packed-cli-boot'
  const traceId = randomUUID()
  const startTime = new Date().toISOString()
  const temp = mkdtempSync(join(tmpdir(), 'omdsh-eval-pack-'))
  const childEnv = limitedEnv()
  const packTui = run('pnpm', ['--filter', '@vanducng/dsh-tui', 'pack', '--pack-destination', temp], {
    env: childEnv,
    timeout: 180_000,
  })
  const packCli = run('pnpm', ['--filter', '@vanducng/oh-my-dsh', 'pack', '--pack-destination', temp], {
    env: childEnv,
    timeout: 180_000,
  })
  const cliVersion = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version
  const tuiTarball = join(temp, `vanducng-dsh-tui-${cliVersion}.tgz`)
  const cliTarball = join(temp, `vanducng-oh-my-dsh-${cliVersion}.tgz`)
  const prefix = join(temp, 'install')
  const install = packTui.status === 0 && packCli.status === 0
    ? run('npm', ['install', '--ignore-scripts', '--global', '--prefix', prefix, tuiTarball, cliTarball], {
        cwd: temp,
        env: childEnv,
        timeout: 180_000,
      })
    : { status: 1, stdout: '', stderr: 'pack failed', error: 'pack-failed' }
  const bin = executable(prefix, 'omdsh')
  const help = existsSync(bin) ? run(bin, ['--help'], { cwd: temp, env: childEnv, timeout: 30_000 }) : { status: 1, stdout: '', stderr: 'missing bin' }
  const version = existsSync(bin) ? run(bin, ['--version'], { cwd: temp, env: childEnv, timeout: 30_000 }) : { status: 1, stdout: '', stderr: 'missing bin' }
  const dumpHome = join(temp, 'home')
  mkdirSync(dumpHome, { recursive: true })
  const dump = existsSync(bin)
    ? run(bin, ['--dump-config'], { cwd: temp, env: limitedEnv({ OMDSH_HOME: dumpHome }), timeout: 60_000 })
    : { status: 1, stdout: '', stderr: 'missing bin' }
  const ok =
    packTui.status === 0 &&
    packCli.status === 0 &&
    install.status === 0 &&
    help.status === 0 &&
    help.stdout.includes('omdsh') &&
    version.status === 0 &&
    version.stdout.trim() === cliVersion &&
    dump.status === 0 &&
    dump.stdout.includes('@vanducng/oh-my-dsh')
  rmSync(temp, { recursive: true, force: true })
  scenarios.push(
    await finishScenario({
      name,
      traceId,
      ok,
      input: { actions: ['pnpm pack', 'npm install --global --prefix', 'omdsh --help', 'omdsh --version', 'omdsh --dump-config'] },
      output: {
        packTui: packTui.status,
        packCli: packCli.status,
        install: install.status,
        help: help.status,
        version: version.stdout.trim(),
        dump: dump.status,
      },
      observations: [
        {
          type: 'span-create',
          id: randomUUID(),
          name: 'packed omdsh boot',
          startTime,
          endTime: new Date().toISOString(),
          input: { cliVersion },
          output: {
            helpOk: help.status === 0 && help.stdout.includes('omdsh'),
            version: version.stdout.trim(),
            dumpHasProductBundle: dump.stdout.includes('@vanducng/oh-my-dsh'),
          },
          level: ok ? 'DEFAULT' : 'ERROR',
          statusMessage: ok ? undefined : clip(packTui.stderr || packCli.stderr || install.stderr || dump.stderr, 200),
        },
      ],
    }),
  )
  if (!ok) {
    console.error(
      `${name} failed packTui=${packTui.status} packCli=${packCli.status} install=${install.status} help=${help.status} version=${version.status} dump=${dump.status}`,
    )
  }
}

const completionModel = modelIds.includes(PREFERRED_MODEL)
  ? PREFERRED_MODEL
  : modelIds.find((id) => id.startsWith('grok-4')) || modelIds[0]

{
  const name = 'cliproxy-completion'
  const traceId = randomUUID()
  const startTime = new Date().toISOString()
  const payload = {
    model: completionModel,
    messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
    max_tokens: 16,
    temperature: 0,
  }
  const probe = await request('cliproxy_chat', `${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${proxyKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    timeoutMs: 60_000,
  })
  let completion = null
  if (probe.response) {
    try {
      completion = await probe.response.json()
    } catch {
      completion = { parseError: true }
    }
  }
  const text = completion?.choices?.[0]?.message?.content
  const usage = completion?.usage
  const ok = probe.ok && typeof text === 'string' && text.trim() !== ''
  scenarios.push(
    await finishScenario({
      name,
      traceId,
      ok,
      input: { model: completionModel, prompt: payload.messages[0].content },
      output: { status: probe.status, error: probe.error, preview: clip(text, 120) },
      observations: [
        {
          type: 'generation-create',
          id: randomUUID(),
          name: 'cliproxy chat.completions',
          startTime,
          endTime: new Date().toISOString(),
          model: completionModel,
          modelParameters: { max_tokens: 16, temperature: 0 },
          input: payload.messages,
          output: text ?? { status: probe.status, error: probe.error },
          usage:
            usage === undefined
              ? undefined
              : {
                  input: usage.prompt_tokens,
                  output: usage.completion_tokens,
                  total: usage.total_tokens,
                  unit: 'TOKENS',
                },
          level: ok ? 'DEFAULT' : 'ERROR',
          statusMessage: ok ? undefined : `HTTP ${probe.status || 0}`,
          metadata: { finish_reason: completion?.choices?.[0]?.finish_reason },
        },
      ],
    }),
  )
  if (!ok) console.error(`${name} failed status=${probe.status || 0}${probe.error ? ` error=${probe.error}` : ''}`)
}

{
  const name = 'cli-deny-unknown-flag'
  const traceId = randomUUID()
  const startTime = new Date().toISOString()
  const result = run('pnpm', ['exec', 'tsx', 'src/bin.ts', '--not-a-real-flag'], {
    cwd: appRoot,
    env: process.env,
    timeout: 30_000,
  })
  const combined = result.stderr + result.stdout
  const ok = result.status === 2 && combined.includes('unknown option')
  scenarios.push(
    await finishScenario({
      name,
      traceId,
      ok,
      input: { argv: ['--not-a-real-flag'] },
      output: { status: result.status, preview: clip(combined, 200) },
      observations: [
        {
          type: 'span-create',
          id: randomUUID(),
          name: 'omdsh unknown flag',
          startTime,
          endTime: new Date().toISOString(),
          input: { argv: ['--not-a-real-flag'] },
          output: { status: result.status, preview: clip(combined, 200) },
          level: 'ERROR',
          statusMessage: 'expected deny: unknown option',
        },
      ],
    }),
  )
  if (!ok) console.error(`${name} failed status=${result.status}`)
}

{
  const name = 'cliproxy-deny-unknown-model'
  const traceId = randomUUID()
  const startTime = new Date().toISOString()
  const payload = {
    model: 'omdsh-eval-nonexistent-model',
    messages: [{ role: 'user', content: 'This request should be rejected.' }],
    max_tokens: 8,
  }
  const probe = await request('cliproxy_deny', `${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${proxyKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    timeoutMs: 30_000,
  })
  let body = null
  if (probe.response) {
    try {
      body = await probe.response.json()
    } catch {
      body = { parseError: true }
    }
  }
  const ok = probe.status >= 400 && probe.status < 500
  scenarios.push(
    await finishScenario({
      name,
      traceId,
      ok,
      input: { model: payload.model },
      output: { status: probe.status, error: probe.error, message: clip(body?.error?.message || body?.message || '', 200) },
      observations: [
        {
          type: 'generation-create',
          id: randomUUID(),
          name: 'cliproxy deny unknown model',
          startTime,
          endTime: new Date().toISOString(),
          model: payload.model,
          input: payload.messages,
          output: { status: probe.status, error: body?.error || body || probe.error },
          level: 'ERROR',
          statusMessage: `HTTP ${probe.status || 0}`,
        },
      ],
    }),
  )
  if (!ok) console.error(`${name} failed status=${probe.status || 0} (expected 4xx)`)
}

const failed = scenarios.filter((row) => !row.ok)
console.log(`EVAL_SUMMARY session=${SESSION_ID} traces=${scenarios.length} passed=${scenarios.length - failed.length} failed=${failed.length}`)
for (const row of scenarios) {
  console.log(`- ${row.name} ${row.ok ? 'PASS' : 'FAIL'} ${tracePath(row.traceId)}`)
}
process.exit(failed.length === 0 ? 0 : 1)
