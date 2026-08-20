import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessGrid, gridDiff, gridFrom, lastRows, normalizeGrid } from './tui-grid.mjs'

test('HeadlessGrid applies CUP and ED so assertions see cells, not ANSI', async () => {
  const grid = new HeadlessGrid({ cols: 20, rows: 4 })
  await grid.write('\x1b[2J\x1b[Htop-left\x1b[2;3Hmid\x1b[3;1Hbottom')
  assert.deepEqual(grid.lines(), ['top-left', '  mid', 'bottom', ''])
  assert.equal(grid.text().includes('\x1b'), false)
  grid.dispose()
})

test('normalizeGrid replaces the longest run-specific paths first', () => {
  const text = '/tmp/omdsh-tui-grid-abc/src/index.ts lives under /tmp/omdsh-tui-grid-abc'
  assert.equal(
    normalizeGrid(text, { $WORKSPACE: '/tmp/omdsh-tui-grid-abc' }),
    '$WORKSPACE/src/index.ts lives under $WORKSPACE',
  )
})

test('normalizeGrid strips trailing spaces so snapshots pass git diff --check', () => {
  assert.equal(normalizeGrid('ptc · code  \n0 steps  '), 'ptc · code\n0 steps')
})

test('gridDiff marks only changed rows', () => {
  const diff = gridDiff('same\nold\n', 'same\nnew\n')
  assert.equal(diff, ' same\n-old\n+new')
})

test('gridFrom and lastRows keep snapshot regions stable', () => {
  const text = 'header tips\n╭─── Agent\nPTC\nfooter'
  assert.equal(gridFrom(text, '╭─── Agent'), '╭─── Agent\nPTC\nfooter')
  assert.equal(lastRows(text, 2), 'PTC\nfooter')
})
