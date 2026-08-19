import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadUserPatches, userPatchPath, userPluginsPatches, userPluginsPath } from './user-patches.ts'

const roots: string[] = []

function temp(name: string): string {
  const path = mkdtempSync(join(tmpdir(), name))
  roots.push(path)
  return path
}

function writePatch(home: string, text: string): void {
  mkdirSync(join(home, 'omdsh'), { recursive: true })
  writeFileSync(join(home, 'omdsh', 'cordis.patch.yml'), text)
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('user patch layer', () => {
  it('resolves the patch path inside the omdsh namespace of the Harness home', () => {
    const home = temp('omdsh-patch-home-')
    expect(userPatchPath({ OMDSH_HOME: home })).toBe(join(home, 'omdsh', 'cordis.patch.yml'))
  })

  it('returns no patches when the file is absent', () => {
    const home = temp('omdsh-patch-home-')
    expect(loadUserPatches({ OMDSH_HOME: home })).toEqual([])
  })

  it('parses insert rows and id-targeted overrides', () => {
    const home = temp('omdsh-patch-home-')
    writePatch(home, [
      '- insert:',
      '    - id: extra',
      "      name: '@deepseek-ai/dsh-session-query'",
      '- id: session-title',
      '  config:',
      '    fallbackMaxWords: 4',
    ].join('\n'))
    expect(loadUserPatches({ OMDSH_HOME: home })).toEqual([
      { insert: [{ id: 'extra', name: '@deepseek-ai/dsh-session-query' }] },
      { id: 'session-title', config: { fallbackMaxWords: 4 } },
    ])
  })

  it('fails loud on a present file that is not a patch list', () => {
    const home = temp('omdsh-patch-home-')
    writePatch(home, 'not-a-list: true')
    expect(() => loadUserPatches({ OMDSH_HOME: home })).toThrow(/omdsh/u)
  })
})

describe('user plugin entry list', () => {
  it('produces no patch when the file is absent', () => {
    const home = temp('omdsh-plugins-home-')
    expect(userPluginsPatches({ OMDSH_HOME: home })).toEqual([])
  })

  it('mounts a present file through an include anchored beside it', () => {
    const home = temp('omdsh-plugins-home-')
    mkdirSync(join(home, 'omdsh'), { recursive: true })
    writeFileSync(join(home, 'omdsh', 'plugins.yml'), '[]\n')
    expect(userPluginsPatches({ OMDSH_HOME: home })).toEqual([
      { insert: [{ id: 'omdsh-user-plugins', name: 'cordis:include', config: { path: userPluginsPath({ OMDSH_HOME: home }) } }] },
    ])
  })
})
