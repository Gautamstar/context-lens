import { expect, mock, test } from 'claude-code/testing'

import { diff, findWaste, formatTokens, mergeCalls, parse } from '../hooks/analyze'
import type { Message } from '../hooks/analyze'

const read = (id: string, path: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(4000) }] },
]

const edit = (id: string, path: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
]

const PANE_PROPS = {
  title: 'Context Lens',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('labels tool results by the call they answer', async () => {
  const { blocks } = parse(read('r1', 'C:\\repo\\src\\app.ts'))
  const result = blocks.find(block => block.kind === 'tool-result')
  expect(result?.label).toBe('Read src/app.ts result')
  expect(result?.tokens).toBe(1000)
})

test('flags every copy of a file but the newest as a duplicate read', async () => {
  const parsed = parse([...read('r1', '/repo/a.ts'), ...read('r2', '/repo/a.ts'), ...read('r3', '/repo/a.ts')])
  const [first] = findWaste(parsed)
  expect(first?.kind).toBe('duplicate-read')
  expect(first?.label).toBe('repo/a.ts read 3 times')
  expect(first?.tokens).toBe(2000)
})

test('flags a read the file was edited past, and leaves a fresh one alone', async () => {
  const stale = findWaste(parse([...read('r1', '/repo/a.ts'), ...edit('e1', '/repo/a.ts')]))
  expect(stale.map(item => item.kind)).toEqual(['stale-read'])

  const fresh = findWaste(parse([...edit('e1', '/repo/a.ts'), ...read('r1', '/repo/a.ts')]))
  expect(fresh).toEqual([])
})

test('flags large non-Read outputs and unused MCP schemas', async () => {
  const parsed = parse([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'y'.repeat(24_000) }] },
  ])
  const waste = findWaste(parsed, [
    { name: 'mcp__sheets__get', serverName: 'sheets', tokens: 900, isLoaded: true },
    { name: 'mcp__sheets__put', serverName: 'sheets', tokens: 700, isLoaded: true },
    { name: 'mcp__drive__find', serverName: 'drive', tokens: 500, isLoaded: false },
  ])
  expect(waste.map(item => item.label)).toEqual(['Bash npm test', 'sheets · 2 unused tools'])
  expect(waste[1]?.tokens).toBe(1600)
})

test('diff reports what a turn added and what a compaction dropped', async () => {
  const before = parse(read('r1', '/a.ts')).blocks
  const after = parse([...read('r1', '/a.ts'), ...read('r2', '/b.ts')]).blocks
  const beforeTokens = before.reduce((sum, block) => sum + block.tokens, 0)

  const grown = diff(before.map(block => block.id), beforeTokens, after)
  expect(grown.added.map(block => block.id)).toEqual(['r2:call', 'r2'])
  expect(grown.droppedTokens).toBe(0)

  const compacted = diff(after.map(block => block.id), beforeTokens * 2, [])
  expect(compacted.droppedTokens).toBe(beforeTokens * 2)
})

test('a tool call and its result merge into one row', async () => {
  const merged = mergeCalls(parse(read('r1', '/repo/src/app.ts')).blocks)
  expect(merged).toHaveLength(1)
  expect(merged[0]?.label).toBe('Read src/app.ts')
  expect(merged[0]?.tokens).toBe(1000 + Math.ceil(JSON.stringify({ file_path: '/repo/src/app.ts' }).length / 4))
})

test('formats token counts compactly', async () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(1000)).toBe('1k')
  expect(formatTokens(8200)).toBe('8.2k')
  expect(formatTokens(124_000)).toBe('124k')
})

test('the pane draws an empty state, then what a measurement found, on every surface', async ($, on) => {
  mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: {
    startedAt: 0,
    rateLimits: [],
    context: {
      tokens: 124_000,
      window: 200_000,
      percent: 62,
      breakdown: {
        categories: [
          { name: 'Messages', tokens: 90_000, color: 'permission', isDeferred: false, kind: 'used' },
          { name: 'Free space', tokens: 76_000, color: 'inactive', isDeferred: false, kind: 'free' },
        ],
        totalTokens: 124_000,
        rawMaxTokens: 200_000,
        percentage: 62,
        mcpTools: [],
      },
    },
  } } as never))
  on('session.messages', () => ({ value: [...read('r1', '/repo/src/app.ts'), ...read('r2', '/repo/src/app.ts')] } as never))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const empty = await $.ui.mount({ plugin: 'context-lens', surface, component: 'Pane', requestId: 'context-lens', props: PANE_PROPS })
    expect(await empty.find({ type: 'Text', text: /Waiting for the first turn/ })).toBeDefined()
    await empty.unmount()
  }

  await $.session.measure({ context: { tokens: 124_000, window: 200_000, percent: 62 }, rateLimits: [], changed: ['context'] })
  // Block estimates (about 2k) scale toward the exact 90k of Messages, clamped at 4x.
  expect(statuses.at(-1)).toBe('ctx 62% · waste 4k')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-lens', surface, component: 'Pane', requestId: 'context-lens', props: PANE_PROPS })
    await ui.press({ key: 'tab-overview' })
    expect(await ui.find({ type: 'Text', text: /124k of 200k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    // Waste and Drop live on the Blocks tab, which says how many rows it holds.
    expect(await ui.find({ key: 'tab-blocks', text: 'Blocks 1' })).toBeDefined()
    await ui.press({ key: 'tab-blocks' })
    expect(await ui.find({ type: 'Text', text: /src\/app\.ts read/ })).toBeDefined()
    expect(await ui.find({ key: 'drop-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /124k of 200k/ })).toBeUndefined()
    await ui.unmount()
  }
})
