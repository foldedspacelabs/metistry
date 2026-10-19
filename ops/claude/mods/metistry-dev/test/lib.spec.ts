import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMIT_TRAILER,
  GH_PR_LIST_ARGV,
  PR_FOOTER,
  formatPr,
  parsePrList,
  rewriteAttribution,
  tailLines,
} from '../hooks/lib.ts'

test('commit text becomes the agent-brief trailer, whatever the engine composed', () => {
  assert.equal(rewriteAttribution('commit', 'Co-Authored-By: Claude <noreply@anthropic.com>'), COMMIT_TRAILER)
  assert.equal(rewriteAttribution('commit', ''), COMMIT_TRAILER)
  assert.equal(rewriteAttribution('commit', 'Use this:\nCo-Authored-By: Other <x@y>\nthanks'), `Use this:\n${COMMIT_TRAILER}\nthanks`)
})

test('pr text becomes the footer', () => {
  assert.equal(rewriteAttribution('pr', '🤖 Generated with [Claude Code](https://claude.com/claude-code)'), PR_FOOTER)
  assert.equal(rewriteAttribution('pr', ''), PR_FOOTER)
})

test('exemption and remedy texts pass through untouched', () => {
  assert.equal(rewriteAttribution('exemption', 'as composed'), 'as composed')
  assert.equal(rewriteAttribution('remedy', 'as composed'), 'as composed')
})

test('the trailer and footer are exactly the strings in docs/ops/agent-brief.md', () => {
  assert.equal(COMMIT_TRAILER, 'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')
  assert.equal(PR_FOOTER, '🤖 Generated with [Claude Code](https://claude.com/claude-code)')
})

test('tailLines keeps the last n non-empty lines, oldest first', () => {
  assert.deepEqual(tailLines('a\n\nb  \nc\nd\n', 2), ['c', 'd'])
  assert.deepEqual(tailLines('', 3), [])
})

test('parsePrList sorts, defaults a missing status, and survives garbage', () => {
  const rows = parsePrList('[{"number":9,"title":"b","mergeStateStatus":"CLEAN"},{"number":2,"title":"a"},{"x":1}]')
  assert.deepEqual(rows, [
    { number: 2, title: 'a', mergeStateStatus: 'UNKNOWN' },
    { number: 9, title: 'b', mergeStateStatus: 'CLEAN' },
  ])
  assert.deepEqual(parsePrList('not json'), [])
  assert.deepEqual(parsePrList('{"a":1}'), [])
})

test('formatPr cuts to the width', () => {
  const line = formatPr({ number: 1, title: 'x'.repeat(100), mergeStateStatus: 'CLEAN' }, 20)
  assert.equal(line.length, 20)
  assert.ok(line.endsWith('…'))
})

test('misuse: the pane runs one read-only gh listing, with no write verb and no git', () => {
  assert.deepEqual([...GH_PR_LIST_ARGV], ['env', '-u', 'GH_TOKEN', 'gh', 'pr', 'list', '--json', 'number,title,mergeStateStatus'])
  assert.ok(!GH_PR_LIST_ARGV.includes('git'))
  for (const verb of ['merge', 'create', 'edit', 'close', 'comment', 'push', 'api']) assert.ok(!GH_PR_LIST_ARGV.includes(verb))
})

test('misuse: the module source holds no write, network, prompt or secret call', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
  for (const banned of ['$.fs.write', '$.fs.remove', '$.http', '$.prompt', '$.session', '$.mcp', '$.model', '$.store', '$.settings', '$.tool.call', '$.process.spawn', '$.env.set', 'git ']) {
    assert.ok(!src.includes(banned), `register.tsx must not use ${banned}`)
  }
  assert.deepEqual([...src.matchAll(/\$\.env\.get\('([A-Z_]+)'\)/g)].map(m => m[1]), ['HOME'])
  assert.equal([...src.matchAll(/\$\.process\.run\(/g)].length, 1)
})
