import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('omdsh composition', () => {
  it('mounts the dormant pi-ai adapter for settings-driven providers', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../config/cordis.yml', import.meta.url)), 'utf8')
    expect(yaml).toContain("name: '@deepseek-ai/dsh-llm-pi-ai'")
    expect(yaml).toContain("name: '@vanducng/dsh-tui'")
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(manifest.dependencies?.['@deepseek-ai/dsh-llm-pi-ai']).toBe('0.1.0-rc.6')
  })
})
