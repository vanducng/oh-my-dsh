import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./format-markdown.mjs', import.meta.url))

test('checks committable Markdown without scanning ignored files', () => {
  const root = mkdtempSync(join(tmpdir(), 'omdsh-markdown-'))
  try {
    mkdirSync(join(root, 'scripts'))
    copyFileSync(script, join(root, 'scripts/format-markdown.mjs'))
    writeFileSync(join(root, '.gitignore'), 'coverage/\n')
    writeFileSync(join(root, 'README.md'), '# Fixture\n')
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd: root })

    writeFileSync(join(root, 'draft.md'), 'first line\nsecond line\n')
    writeFileSync(join(root, 'deleted.md'), '# Deleted\n')
    execFileSync('git', ['add', 'deleted.md'], { cwd: root })
    rmSync(join(root, 'deleted.md'))
    mkdirSync(join(root, 'coverage'))
    writeFileSync(join(root, 'coverage/ignored.md'), 'ignored line\nneeds formatting\n')

    const result = spawnSync(process.execPath, ['scripts/format-markdown.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stdout, /draft\.md/u)
    assert.doesNotMatch(result.stdout, /coverage\/ignored\.md/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
