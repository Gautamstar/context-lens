// Context ablation: replay the last question with one block of context taken
// out, and see whether the answer changes. A block whose removal changes the
// answer is one the answer relied on; one whose removal changes nothing was
// along for the ride.
//
// Everything here is pure; register.tsx makes the model calls.

import type { ContentBlock, Message } from './analyze'
import { estimateTokens, parse } from './analyze'

// One block of the conversation as the replay shows it to the model.
export type Segment = { id: string; label: string; tokens: number; text: string }

export type Replay = {
  // Everything before the question, in order.
  segments: Segment[]
  question: string
  // What the assistant actually said; shown in the pane, never sent.
  answer: string
}

export type TextBlock = { text: string; cache?: true }

const MIN_CANDIDATE_TOKENS = 200

// The API allows four cache marks per request; the replays use three, so a
// fourth stays free for whatever a provider adds.
const CACHE_MARKS = 3

const HEADER =
  'Below is the transcript of a coding session between a user and an AI assistant, ' +
  'including the tool calls the assistant made and what they returned.\n\n<transcript>\n'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

// Slash commands and their output come back as user text; they are no question.
const isCommandRecord = (text: string): boolean => /<command-name>|<local-command-/.test(text)

const resultBody = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentBlock[])
    .map(part => (part.type === 'text' ? str(part.text) : `[${part.type}]`))
    .join('\n')
}

const bodyOf = (part: ContentBlock): string => {
  if (part.type === 'text') return str(part.text)
  if (part.type === 'tool_use') return JSON.stringify(part.input ?? {})
  if (part.type === 'tool_result') return resultBody(part.content)
  return ''
}

// Splits the conversation at the last question that got an answer. Thinking,
// images and documents are left out of the replay: a text-only model call
// cannot carry them as the session did.
export const toReplay = (messages: readonly Message[]): Replay | undefined => {
  const { blocks } = parse(messages)
  const flat: { block: (typeof blocks)[number]; part: ContentBlock }[] = []
  let i = 0
  for (const message of messages) {
    for (const part of message.content) {
      if (!['text', 'thinking', 'tool_use', 'tool_result', 'image', 'document'].includes(part.type)) continue
      const block = blocks[i++]
      if (block) flat.push({ block, part })
    }
  }

  let questionAt = -1
  for (let k = flat.length - 1; k >= 0; k--) {
    const entry = flat[k]!
    if (entry.block.kind !== 'prompt' || isCommandRecord(bodyOf(entry.part))) continue
    const hasAnswer = flat.slice(k + 1).some(later => later.block.kind === 'reply')
    if (hasAnswer) {
      questionAt = k
      break
    }
  }
  if (questionAt < 0) return undefined

  const answer = flat
    .slice(questionAt + 1)
    .filter(entry => entry.block.kind === 'reply')
    .map(entry => bodyOf(entry.part))
    .join('\n')

  const segments = flat
    .slice(0, questionAt)
    .filter(entry => entry.block.kind !== 'thinking' && entry.block.kind !== 'media')
    .map(({ block, part }) => ({
      id: block.id,
      label: block.label,
      tokens: block.tokens,
      text: `[${block.label}]\n${bodyOf(part)}\n\n`,
    }))

  return { segments, question: bodyOf(flat[questionAt]!.part), answer }
}

// The blocks worth testing: the biggest ones, since they cost the most to keep.
export const pickCandidates = (replay: Replay, count: number): Segment[] =>
  [...replay.segments]
    .filter(segment => segment.tokens >= MIN_CANDIDATE_TOKENS)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, count)

// Where the replays put their cache marks: just before the earliest candidates.
// Every replay sends the same text up to the block it removes, so a mark there
// lets the API serve that prefix from cache instead of billing it again.
export const cacheMarks = (replay: Replay, candidates: readonly Segment[]): number[] => {
  const position = new Map(replay.segments.map((segment, at) => [segment.id, at]))
  return candidates
    .map(candidate => position.get(candidate.id) ?? 0)
    .filter(at => at > 0)
    .sort((a, b) => a - b)
    .slice(0, CACHE_MARKS)
}

// The prompt for one replay, `without` naming the block to remove (none for
// the baseline). The removed block is left out entirely, so nothing hints at
// what is missing.
export const replayPrompt = (replay: Replay, marks: readonly number[], without?: string): TextBlock[] => {
  const skipAt = without === undefined ? -1 : replay.segments.findIndex(segment => segment.id === without)
  // Marks past the removed block would sit on text no other replay sends.
  const usable = skipAt < 0 ? marks : marks.filter(at => at <= skipAt)
  const prompt: TextBlock[] = []
  let from = 0
  let head = HEADER
  for (const at of usable) {
    const text = head + replay.segments.slice(from, at).map(segment => segment.text).join('')
    prompt.push({ text, cache: true })
    head = ''
    from = at
  }
  const rest = replay.segments
    .slice(from)
    .filter((_, k) => from + k !== skipAt)
    .map(segment => segment.text)
    .join('')
  prompt.push({
    text:
      head + rest + '</transcript>\n\n' +
      `The user's next message:\n<question>\n${replay.question}\n</question>\n\n` +
      'Reply as the assistant would at this point in the session. Give its answer and ' +
      'the actions it would take, in at most 150 words, with no preamble.',
  })
  return prompt
}

export const promptTokens = (prompt: readonly TextBlock[]): number =>
  prompt.reduce((sum, block) => sum + estimateTokens(block.text), 0)

// What the judge sees: two answers to the same question, labelled neutrally.
export const judgeText = (question: string, a: string, b: string): string =>
  `Question:\n${question}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}\n\n` +
  'Do A and B reach the same conclusions and propose the same actions? ' +
  'Wording does not matter, substance does.'

export const JUDGE_LABELS = ['same', 'partly different', 'different'] as const
export type JudgeLabel = (typeof JUDGE_LABELS)[number]

export type Verdict = 'needed' | 'partly' | 'unused' | 'failed'

export const verdictOf = (label: string | undefined): Verdict =>
  label === 'different' ? 'needed' : label === 'partly different' ? 'partly' : label === 'same' ? 'unused' : 'failed'

// List prices in dollars per million tokens, for the estimate shown before a
// run. Haiku's are for prompts under 100k tokens, which the size cap keeps to.
export const PRICES: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.1, output: 0.5 },
  sonnet: { input: 2, output: 10 },
}

// A replay's answer is capped at 150 words; this is a little over that.
const ANSWER_TOKENS = 300

export type AblationEstimate = { replays: number; promptTokens: number; totalTokens: number; usd?: number }

// What a run would send: the baseline twice, then one replay per candidate.
// Priced as if nothing came from the prompt cache: the replays do mark a
// shared prefix, but how much of it the API serves from cache varies (one live
// run read only a fifth of its input from cache), so this is a ceiling.
export const estimateAblation = (
  replay: Replay,
  candidates: readonly Segment[],
  marks: readonly number[],
  model: string,
): AblationEstimate => {
  const promptSize = promptTokens(replayPrompt(replay, marks))
  const replays = candidates.length + 2
  const price = PRICES[model]
  const usd = price && (replays * (promptSize * price.input + ANSWER_TOKENS * price.output)) / 1_000_000
  return { replays, promptTokens: promptSize, totalTokens: replays * promptSize, usd }
}
