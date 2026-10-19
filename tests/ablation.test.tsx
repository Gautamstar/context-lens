import { expect, mock, test } from 'claude-code/testing'

import { cacheMarks, pickCandidates, replayPrompt, toReplay, verdictOf } from '../hooks/ablation'
import type { Message } from '../hooks/analyze'

const read = (id: string, path: string, body: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
]

// Two big reads, a question, an answer, then a slash command that is no question.
const CONVERSATION: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
  ...read('r1', '/repo/src/auth.ts', 'AUTH-BODY ' + 'a'.repeat(4000)),
  ...read('r2', '/repo/src/styles.css', 'CSS-BODY ' + 'c'.repeat(8000)),
  { role: 'assistant', content: [{ type: 'text', text: 'Read both.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Why does login fail?' }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'The token check is inverted.' }] },
  { role: 'user', content: [{ type: 'text', text: '<command-name>/ctx</command-name>' }] },
]

const PANE_PROPS = {
  title: 'Context Lens',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
} as const

test('the replay stops at the last answered question and skips command records', async () => {
  const replay = toReplay(CONVERSATION)
  expect(replay?.question).toBe('Why does login fail?')
  expect(replay?.answer).toBe('The token check is inverted.')
  expect(replay?.segments.map(segment => segment.id)).toEqual(['m0.0', 'r1:call', 'r1', 'r2:call', 'r2', 'm5.0'])
})

test('there is nothing to replay before the first answer', async () => {
  expect(toReplay([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBeUndefined()
})

test('candidates are the biggest blocks, small ones left out', async () => {
  const replay = toReplay(CONVERSATION)!
  expect(pickCandidates(replay, 5).map(segment => segment.id)).toEqual(['r2', 'r1'])
  expect(pickCandidates(replay, 1).map(segment => segment.id)).toEqual(['r2'])
})

test('a replay without a block leaves it out and keeps the cached prefix byte for byte', async () => {
  const replay = toReplay(CONVERSATION)!
  const candidates = pickCandidates(replay, 5)
  const marks = cacheMarks(replay, candidates)
  expect(marks).toEqual([2, 4])

  const baseline = replayPrompt(replay, marks)
  const withoutCss = replayPrompt(replay, marks, 'r2')
  const withoutAuth = replayPrompt(replay, marks, 'r1')
  const joined = (prompt: { text: string }[]) => prompt.map(block => block.text).join('')

  expect(joined(baseline)).toContain('CSS-BODY')
  expect(joined(withoutCss)).not.toContain('CSS-BODY')
  expect(joined(withoutCss)).toContain('AUTH-BODY')
  expect(joined(withoutAuth)).not.toContain('AUTH-BODY')

  // Every cache-marked block of a replay is one the baseline sent first.
  for (const replayed of [withoutCss, withoutAuth]) {
    replayed.filter(block => block.cache).forEach((block, k) => expect(block).toEqual(baseline[k]))
  }
  expect(withoutAuth.filter(block => block.cache)).toHaveLength(1)
  expect(withoutCss.filter(block => block.cache)).toHaveLength(2)
  expect(joined(baseline)).toContain('Why does login fail?')
})

test('judge labels map to verdicts', async () => {
  expect(verdictOf('different')).toBe('needed')
  expect(verdictOf('partly different')).toBe('partly')
  expect(verdictOf('same')).toBe('unused')
  expect(verdictOf(undefined)).toBe('failed')
})

test('the pane button runs an ablation and shows which blocks were needed', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const prompts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } } as never))
  on('session.messages', () => ({ value: CONVERSATION } as never))
  // The answer depends on the auth file alone, as a real model's would here.
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    const text = e.prompt.includes('AUTH-BODY') ? 'The token check is inverted.' : 'I would need to see the auth code.'
    return { value: { isAnswered: true, text, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } } as never
  })
  on('model.classify', (_, e) => {
    const [, a = '', b = ''] = e.text.split(/Answer [AB]:\n/)
    return { value: a.split('\n')[0] === b.split('\n')[0] ? 'same' : 'different' } as never
  })

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-lens', surface: 'desktop', component: 'Pane', requestId: 'context-lens', props: PANE_PROPS })
  await ui.press({ key: 'tab-ablation' })
  await ui.press({ key: 'ablate' })
  await clock.settle()

  // Nothing runs until the estimate is confirmed.
  expect(prompts).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /4 replays with haiku/ })).toBeDefined()
  expect(toasts.at(-1)).toMatch(/^Testing 2 blocks takes 4 replays with haiku .*under \$0\.01 at list price/)
  await ui.press({ key: 'ablate-run' })
  await clock.settle()

  expect(prompts).toHaveLength(4)
  expect(await ui.find({ key: 'ablate-run' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1 needed.*of 2 tested with haiku/ })).toBeDefined()
  expect(await ui.find({ key: 'ablate-r1' })).toBeDefined()
  const auth = await ui.find({ key: 'ablate-r1' })
  const css = await ui.find({ key: 'ablate-r2' })
  expect(auth?.text).toMatch(/needed/)
  expect(css?.text).toMatch(/unused/)
  expect(await ui.find({ type: 'Text', text: /baseline replays disagreed/ })).toBeUndefined()
  expect(toasts.at(-1)).toBe('Context Lens: the last answer needed 1 of 2 blocks tested.')
  await ui.unmount()
})
