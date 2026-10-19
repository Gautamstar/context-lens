import { expect, mock, test } from 'claude-code/testing'

import type { Message } from '../hooks/analyze'

// Nothing in Context Lens may spend model tokens unless the person asked.

const read = (id: string, path: string, body: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
]

const PANE_PROPS = {
  title: 'Context Lens',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
} as const

// The same file read twice, so the older copy is flagged with a Drop button.
const CONVERSATION: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
  ...read('r1', '/repo/src/auth.ts', 'a'.repeat(4000)),
  ...read('r2', '/repo/src/auth.ts', 'a'.repeat(4000)),
  { role: 'user', content: [{ type: 'text', text: 'Why does login fail?' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'The token check is inverted.' }] },
]

const ROWS = [
  { role: 'assistant', text: '', toolUses: [], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], handle: 'h2', toolResults: [{ tool_use_id: 'r1', text: 'old copy', isError: false }] },
  { role: 'user', text: '', toolUses: [], handle: 'h3', toolResults: [{ tool_use_id: 'r2', text: 'new copy', isError: false }] },
]

test('a Drop whose /compact starts late still trims, and never summarizes', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  let summarized = false
  let kept: readonly unknown[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } } as never))
  on('session.messages', (_, e) => ({ value: e.as === 'api' ? CONVERSATION : [] } as never))
  // The engine's own compaction, the one that summarizes and costs tokens.
  on('session.compact', (_, e) => ((summarized = true), { messages: e.messages }))
  // Claude was busy: the queued /compact waits until the test lets it finish.
  let release = () => {}
  const queued = new Promise<void>(resolve => (release = resolve))
  on('command.run', { command: 'compact' }, () => queued.then(() => ({ text: '' })))

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-lens', surface: 'desktop', component: 'Pane', requestId: 'context-lens', props: PANE_PROPS })
  await ui.press({ key: 'tab-blocks' })
  await ui.press({ key: 'drop-0' })
  // The compaction itself starts three minutes after the Drop.
  await clock.advance(180_000)
  const result = await $.session.compact({ trigger: 'manual', messages: ROWS } as never)
  kept = result.messages ?? []
  release()
  await clock.settle()

  expect(summarized).toBe(false)
  expect(JSON.stringify(kept)).toMatch(/Context Lens removed this tool result/)
  expect(JSON.stringify(kept)).toMatch(/new copy/)
  expect(toasts.at(-1)).toMatch(/^Dropped /)
  await ui.unmount()
})

test('/ctx ablate run only starts when the person typed it', async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: CONVERSATION } as never))
  on('model.complete', () => (calls++, { value: { isAnswered: true, text: 'same' } } as never))
  on('model.classify', () => ({ value: 'same' } as never))
  on('ui.toast', () => ({ value: undefined }))
  const run = (args: string, kind: string) =>
    $.command.run({ command: 'ctx', args, origin: { kind } } as never) as Promise<{ text: string }>

  await run('ablate 1', 'composer')
  for (const kind of ['scheduled-trigger', 'peer', 'task-notification', 'plugin']) {
    expect((await run('ablate run', kind)).text).toMatch(/only when you start it/)
  }
  await clock.settle()
  expect(calls).toBe(0)

  expect((await run('ablate run', 'composer')).text).toMatch(/^Testing 1 block/)
  await clock.settle()
  expect(calls).toBe(3)
})
