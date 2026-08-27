import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const check = process.argv.includes('--check')
const execFileAsync = promisify(execFile)
const skippedGenerated = new Set([
  'apps/site/src/docs',
  'apps/site/src/zh/docs',
  'apps/site/src/changelog.md',
  'apps/site/src/zh/changelog.md',
])

async function markdownFiles() {
  const { stdout } = await execFileAsync('git', [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--deduplicate',
    '--',
    '*.md',
  ], { cwd: root, encoding: 'utf8' })

  const paths = stdout
    .split('\0')
    .filter((path) => {
      if (path === '' || path === 'CHANGELOG.md' || path.endsWith('/CHANGELOG.md')) return false
      return ![...skippedGenerated].some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    })
    .map(path => resolve(root, path))

  const files = await Promise.all(paths.map(async (path) => {
    try {
      return (await stat(path)).isFile() ? path : undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }))
  return files.filter(file => file !== undefined)
}

function isStandaloneBlock(line) {
  const trimmed = line.trimStart()
  return /^(?:#{1,6}\s|>|<|\[[^\]]+\]:|(?:[-*_]\s*){3,}$)/u.test(trimmed)
    || /^\s{4}|^\t/u.test(line)
    || line.includes('|')
}

function listItem(line) {
  return /^(\s*(?:[-+*]|\d+[.)])\s+)(.*)$/u.exec(line)
}

function formatMarkdown(source) {
  const input = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const output = []
  let paragraph = []
  let fence
  let frontmatter = input[0] === '---'

  const flush = () => {
    if (paragraph.length === 0) return
    output.push(paragraph.map(line => line.trim()).join(' '))
    paragraph = []
  }

  for (let index = 0; index < input.length; index += 1) {
    const line = input[index] ?? ''

    if (frontmatter) {
      output.push(line)
      if (index > 0 && line === '---') frontmatter = false
      continue
    }

    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line)
    if (fence !== undefined) {
      output.push(line)
      if (fenceMatch?.[1]?.startsWith(fence[0]) && fenceMatch[1].length >= fence.length) fence = undefined
      continue
    }
    if (fenceMatch?.[1] !== undefined) {
      flush()
      fence = fenceMatch[1]
      output.push(line)
      continue
    }

    if (line.trim() === '') {
      flush()
      if (output.at(-1) !== '') output.push('')
      continue
    }

    if (/ {2}$|\\$/u.test(line)) {
      flush()
      output.push(line)
      continue
    }

    const item = listItem(line)
    if (item !== null) {
      flush()
      paragraph = [(item[1] ?? '') + (item[2] ?? '').trim()]
      continue
    }

    if (isStandaloneBlock(line)) {
      flush()
      output.push(line)
      continue
    }

    paragraph.push(line)
  }
  flush()
  while (output.at(-1) === '') output.pop()
  return output.join('\n') + '\n'
}

const changed = []
for (const file of await markdownFiles()) {
  const source = await readFile(file, 'utf8')
  const formatted = formatMarkdown(source)
  if (formatted === source) continue
  changed.push(relative(root, file))
  if (!check) await writeFile(file, formatted)
}

if (changed.length > 0) {
  const action = check ? 'Need formatting' : 'Formatted'
  process.stdout.write(`${action}:\n${changed.map(file => `  ${file}`).join('\n')}\n`)
  if (check) process.exitCode = 1
}
