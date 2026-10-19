import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { estimateAblation, pickCandidates, cacheMarks, toReplay } from '../hooks/ablation'
import type { Message } from '../hooks/analyze'
import { compactionHints, editedFiles, withHints } from '../hooks/hints'
import type { Ablation, Waste } from '../types'

const read = (id: string, path: string, body: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
]

const CONVERSATION: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
  ...read('r1', '/repo/src/auth.ts', 'a'.repeat(40_000)),
  ...read('r2', '/repo/src/styles.css', 'c'.repeat(80_000)),
  { role: 'user', content: [{ type: 'text', text: 'Why does login fail?' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'The token check is inverted.' }] },
]

const DONE: Ablation = {
  status: 'done', startedAt: 0, model: 'haiku', question: 'q', inputTokens: 0, cachedTokens: 0, outputTokens: 0,
  results: [
    { id: 'r1', label: 'Read src/auth.ts', tokens: 10_000, verdict: 'needed' },
    { id: 'r2', label: 'Read src/styles.css', tokens: 20_000, verdict: 'unused' },
  ],
}

const WASTE: Waste[] = [
  { kind: 'stale-read', label: 'src/app.ts edited after it was read', tokens: 3000, blockIds: ['t1'] },
  { kind: 'large-output', label: 'Bash npm test', tokens: 9000, blockIds: ['t2'] },
  { kind: 'unused-mcp', label: 'github · 30 unused tools', tokens: 8000, blockIds: [] },
]

test('the estimate counts every replay and prices it as uncached, a ceiling', () => {
  const replay = toReplay(CONVERSATION)!
  const candidates = pickCandidates(replay, 5)
  const marks = cacheMarks(replay, candidates)
  const haiku = estimateAblation(replay, candidates, marks, 'haiku')
  expect(haiku.replays).toBe(4)
  expect(haiku.totalTokens).toBe(haiku.promptTokens * 4)
  // About 30k tokens a replay: a few cents on Haiku at most, far more on Sonnet.
  expect(haiku.usd).toBeGreaterThan(0)
  expect(haiku.usd!).toBeLessThan(0.02)
  const sonnet = estimateAblation(replay, candidates, marks, 'sonnet')
  expect(sonnet.usd!).toBeGreaterThan(haiku.usd! * 10)
  expect(estimateAblation(replay, candidates, marks, 'claude-opus-5-5').usd).toBeUndefined()
})

test('compaction notes name edited files, needed blocks and what to drop', () => {
  const edited = editedFiles([
    { tool: 'Edit', input: { file_path: 'C:\\repo\\src\\app.ts' } },
    { tool: 'Read', input: { file_path: '/repo/README.md' } },
    { tool: 'Write', input: { file_path: 'c:/repo/src/app.ts' } },
    { tool: 'NotebookEdit', input: { notebook_path: '/repo/n.ipynb' } },
  ])
  expect(edited).toEqual(['C:\\repo\\src\\app.ts', '/repo/n.ipynb'])

  const hints = compactionHints({ edited, ablation: DONE, waste: WASTE })!
  expect(hints).toMatch(/^Notes from Context Lens/)
  expect(hints).toMatch(/edited in this session.*app\.ts; \/repo\/n\.ipynb/)
  expect(hints).toMatch(/depended on these blocks.*Read src\/auth\.ts\./)
  expect(hints).not.toMatch(/styles\.css/)
  expect(hints).toMatch(/out of date.*src\/app\.ts edited after it was read/)
  expect(hints).toMatch(/one line each.*Bash npm test/)
  expect(hints).not.toMatch(/github/)

  expect(compactionHints({ edited: [], ablation: { ...DONE, status: 'running' }, waste: [] })).toBeUndefined()
  expect(withHints('  keep the API notes ', 'NOTES')).toBe('keep the API notes\n\nNOTES')
  expect(withHints(undefined, undefined)).toBeUndefined()
})

// Starts a session drawn on the given surfaces; answers which panes opened.
const startOn = (surfaces: readonly ('terminal' | 'desktop')[]) => async ($: Engine, on: On) => {
  const opened: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } } as never))
  on('session.surfaces', () => ({ value: surfaces }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/repo', surface: surfaces[0] ?? null, isInteractive: true })
  return opened
}

test('by default the pane opens by itself in the app, not in a terminal', async ($, on) => {
  expect(await startOn(['terminal'])($, on)).toEqual([])
})

test('by default the pane opens by itself in the desktop app', async ($, on) => {
  expect(await startOn(['desktop'])($, on)).toEqual(['context-lens'])
})

test('autoOpen always opens it in a terminal too', { options: { autoOpen: 'always' } }, async ($, on) => {
  expect(await startOn(['terminal'])($, on)).toEqual(['context-lens'])
})

test('autoOpen never leaves it to /ctx', { options: { autoOpen: 'never' } }, async ($, on) => {
  expect(await startOn(['desktop'])($, on)).toEqual([])
})

test('a /compact is told what Context Lens knows, after the person\'s own text', async ($, on) => {
  let told: string | undefined
  on('session.compact', (_, e) => ((told = e.instructions), { messages: e.messages }))
  await $.session.compact({
    trigger: 'manual',
    instructions: 'keep the API notes',
    messages: [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/repo/src/app.ts' } }] },
    ],
  } as never)
  expect(told).toMatch(/^keep the API notes\n\nNotes from Context Lens/)
  expect(told).toMatch(/\/repo\/src\/app\.ts/)
})

test('compactionHints off passes the instructions through untouched', { options: { compactionHints: false } }, async ($, on) => {
  let told: string | undefined = 'unset'
  on('session.compact', (_, e) => ((told = e.instructions), { messages: e.messages }))
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }] }],
  } as never)
  expect(told).toBeUndefined()
})

test('/ctx ablate shows the cost and runs nothing until /ctx ablate run', { options: { ablationModel: 'sonnet' } }, async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: CONVERSATION } as never))
  on('model.complete', () => (calls++, { value: { isAnswered: true, text: 'same answer' } } as never))
  on('model.classify', () => ({ value: 'same' } as never))
  on('ui.toast', () => ({ value: undefined }))

  const planned = await $.command.run({ command: 'ctx', args: 'ablate 2' } as never)
  expect((planned as { text: string }).text).toMatch(/^Testing 2 blocks takes 4 replays with sonnet .*\$0\.\d\d at list price/)
  await clock.settle()
  expect(calls).toBe(0)

  const cancelled = await $.command.run({ command: 'ctx', args: 'ablate cancel' } as never)
  expect((cancelled as { text: string }).text).toBe('Ablation cancelled.')
  const nothing = await $.command.run({ command: 'ctx', args: 'ablate run' } as never)
  expect((nothing as { text: string }).text).toMatch(/^Nothing to run/)

  await $.command.run({ command: 'ctx', args: 'ablate 2' } as never)
  const ran = await $.command.run({ command: 'ctx', args: 'ablate run' } as never)
  expect((ran as { text: string }).text).toBe('Testing 2 blocks with sonnet. Results fill in the Context Lens pane.')
  await clock.settle()
  expect(calls).toBe(4)
})
