import { expect, mock, test } from 'claude-code/testing'

import { autoCompactPoint, calibrate, estimateTranscript, findWaste, parse, stubResults } from '../hooks/analyze'
import type { Message } from '../hooks/analyze'

const read = (id: string, path: string, body = 'x'.repeat(4000)): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
]

const PANE_PROPS = {
  title: 'Context Lens',
  isFocused: false,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
} as const

test('a read whose file changed on disk afterwards is stale, with a Drop target', async () => {
  const parsed = parse(read('r1', '/repo/a.ts'))
  expect(findWaste(parsed)).toEqual([])
  const [stale] = findWaste(parsed, [], new Set(['r1']))
  expect(stale?.label).toBe('repo/a.ts changed on disk after it was read')
  expect(stale?.blockIds).toEqual(['r1'])
  // Paths compare without case, but the label keeps the spelling of the call.
  const [cased] = findWaste(parse(read('r2', 'C:/Repo/README.md')), [], new Set(['r2']))
  expect(cased?.label).toBe('Repo/README.md changed on disk after it was read')
})

test('calibration scales blocks toward the exact count, within limits', async () => {
  const { blocks } = parse(read('r1', '/a.ts'))
  const estimated = blocks.reduce((sum, block) => sum + block.tokens, 0)
  expect(calibrate(blocks, estimated * 2).factor).toBe(2)
  expect(calibrate(blocks, estimated * 2).blocks[1]?.tokens).toBe(2000)
  expect(calibrate(blocks, estimated * 100).factor).toBe(4)
  expect(calibrate(blocks, undefined).factor).toBe(1)
})

test('a transcript is sized from its text, tool inputs and results', async () => {
  expect(estimateTranscript([
    { text: 'abcd', toolUses: [{ input: {}, text: 'efgh' }] },
    { text: '', toolUses: [], toolResults: [{ text: 'x'.repeat(40) }] },
  ])).toBe(1 + 1 + 1 + 0 + 10)
})

test('Read times, turn costs and subagents reach the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const conversation: Message[] = [
    ...read('r1', '/repo/a.ts'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Map the auth flow', subagent_type: 'Explore', prompt: 'go' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Auth goes through middleware.' }] },
  ]
  const rows = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/repo/a.ts' } }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'ag1', tool: 'Agent', input: { description: 'Map the auth flow', subagent_type: 'Explore' }, agentId: 'agent-1' }] },
  ]
  const agentRows = [{ role: 'assistant', text: 'y'.repeat(80_000), toolUses: [] }]
  let cost = 0.5
  let percent = 25
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 50_000, percent }, cost: { usd: cost } } } as never))
  on('session.messages', (_, e) => ({
    value: e.agentId === 'agent-1' ? agentRows : e.as === 'api' ? conversation : rows,
  } as never))
  // The file is modified ten seconds after the read finished.
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 1_010_000, isLink: false } } as never))
  on('tool.call', () => ({ result: {}, text: 'file body' } as never))
  on('turn.complete', (_, e) => ({ text: e.answer } as never))

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/repo/a.ts' } as never)
  await clock.advance(5000)
  await $.turn.complete({
    answer: 'The login flow checks the session cookie.', durationMs: 42_000, isAborted: false, turnId: 't-agent',
    agentId: 'agent-1', reason: 'answer',
    usage: { input_tokens: 2000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 8000, output_tokens: 1500, model: 'claude-haiku-5-5' },
  } as never)
  // The first main turn sets where the session's cost total stands; the next is priced from it.
  const mainTurn = { answer: 'Done.', durationMs: 9000, isAborted: false, turnId: 't-main', reason: 'answer' }
  await $.turn.complete({ ...mainTurn, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, model: 'claude-opus-5-5' } } as never)
  cost = 0.62
  await $.turn.complete({
    answer: 'Done.', durationMs: 9000, isAborted: false, turnId: 't-main', reason: 'answer',
    usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 300, model: 'claude-opus-5-5' },
  } as never)
  await $.session.measure({ context: { window: 200_000, tokens: 50_000, percent: 25 }, rateLimits: [], changed: ['context'] })
  percent = 40
  await $.session.measure({ context: { window: 200_000, tokens: 80_000, percent: 40 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'context-lens', surface: 'desktop', component: 'Pane', requestId: 'context-lens', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /10k in · 90% cached · 300 out · \$0\.12/ })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.press({ key: 'tab-blocks' })
  expect(await ui.find({ type: 'Text', text: /a\.ts changed on disk/ })).toBeDefined()
  expect(await ui.find({ key: 'drop-0' })).toBeDefined()
  await ui.press({ key: 'tab-agents' })
  expect(await ui.find({ type: 'Text', text: 'Map the auth flow' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /20k → 11/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Explore · haiku-5-5 · processed 70k · 42s/ })).toBeDefined()
  await ui.unmount()

  // The terminal draws the timeline as a sparkline instead of an SVG.
  const term = await $.ui.mount({ plugin: 'context-lens', surface: 'terminal', component: 'Pane', requestId: 'context-lens', props: PANE_PROPS })
  await term.press({ key: 'tab-overview' })
  expect(await term.find({ type: 'Text', text: '▃▄' })).toBeDefined()
  await term.unmount()
})

test('Drop stubs out exactly the flagged results and keeps every other message whole', async () => {
  const rows = [
    { role: 'assistant', text: '', toolUses: [], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], handle: 'h2', toolResults: [
      { tool_use_id: 'r1', text: 'old body', isError: false },
      { tool_use_id: 'r2', text: 'keep me', isError: false },
    ] },
    { role: 'user', text: 'next question', toolUses: [], handle: 'h3' },
  ]
  const out = stubResults(rows, new Set(['r1']), 'STUB')
  expect(out[0]).toBe(rows[0])
  expect(out[2]).toBe(rows[2])
  expect(out[1]?.handle).toBeUndefined()
  expect(out[1]?.toolResults).toEqual([
    { tool_use_id: 'r1', text: 'STUB', isError: false },
    { tool_use_id: 'r2', text: 'keep me', isError: false },
  ])
  expect(stubResults(rows, new Set(['nope']), 'STUB')).toEqual(rows)
})

test('the auto-compact point honors CLAUDE_AUTOCOMPACT_PCT_OVERRIDE as the engine does', () => {
  // A 1M window reports 987k; at 40% the engine compacts at 400k.
  expect(autoCompactPoint(987_000, '40')).toBe(400_000)
  // The override only lowers the point.
  expect(autoCompactPoint(187_000, '99')).toBe(187_000)
  expect(autoCompactPoint(987_000, undefined)).toBe(987_000)
  expect(autoCompactPoint(987_000, 'abc')).toBe(987_000)
  expect(autoCompactPoint(987_000, '0')).toBe(987_000)
})
