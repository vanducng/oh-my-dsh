import assert from 'node:assert/strict'
import test from 'node:test'
import { DSH_COHORT, packedInstallOverrides } from './packed-install-overrides.mjs'

test('packedInstallOverrides pins identity packages and declared DSH deps to the cohort', () => {
  const overrides = packedInstallOverrides({
    dependencies: {
      '@deepseek-ai/dsh-agent': '0.1.5-rc.1',
      '@vanducng/dsh-tui': 'workspace:^',
    },
  })
  assert.equal(overrides['@deepseek-ai/cordis'], '4.0.2')
  assert.equal(overrides['@deepseek-ai/dsh-scope'], DSH_COHORT)
  assert.equal(overrides['@deepseek-ai/dsh-system-prompt'], DSH_COHORT)
  assert.equal(overrides['@deepseek-ai/dsh-agent'], DSH_COHORT)
  assert.equal(overrides['@vanducng/dsh-tui'], undefined)
})
