// Notes for the summarizer when a normal compaction runs. The summary is
// written by a model that sees the transcript but not what this mod measured:
// which files changed, which blocks the last answer leaned on, and which ones
// are old or repeated copies. Telling it keeps the right things in the summary.
//
// Everything here is pure; register.tsx hands the text to session.compact.

import type { Ablation, Waste } from '../types'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// How many names each note lists, so the instructions stay short.
const MAX_NAMED = 12

type ToolUse = { tool: string; input: Record<string, unknown> }

// The files the conversation edited, in the order first edited, each once.
export const editedFiles = (uses: readonly ToolUse[]): string[] => {
  const seen = new Map<string, string>()
  for (const use of uses) {
    if (!EDIT_TOOLS.has(use.tool)) continue
    const path = use.input.file_path ?? use.input.notebook_path
    if (typeof path !== 'string' || path === '') continue
    const key = path.replace(/\\/g, '/').toLowerCase()
    if (!seen.has(key)) seen.set(key, path)
  }
  return [...seen.values()]
}

export type HintSources = {
  edited: readonly string[]
  ablation: Ablation | null
  waste: readonly Waste[]
}

const list = (names: readonly string[]) => {
  const shown = names.slice(0, MAX_NAMED).join('; ')
  return names.length > MAX_NAMED ? `${shown}; and ${names.length - MAX_NAMED} more` : shown
}

// What each note covers, for the pane to say before a compaction runs.
export const hintCounts = ({ edited, ablation, waste }: HintSources) => ({
  edited: edited.length,
  needed: ablation?.status === 'done'
    ? ablation.results.filter(result => result.verdict === 'needed' || result.verdict === 'partly').length
    : 0,
  shorten: waste.filter(item => item.blockIds.length > 0).length,
})

// The notes, or undefined when there is nothing worth saying.
export const compactionHints = ({ edited, ablation, waste }: HintSources): string | undefined => {
  const notes: string[] = []
  if (edited.length > 0) {
    notes.push(
      'These files were edited in this session. Keep each one\'s path, what changed in it and why, ' +
      `and any edit still unfinished: ${list(edited)}.`,
    )
  }
  const needed = ablation?.status === 'done'
    ? ablation.results.filter(result => result.verdict === 'needed' || result.verdict === 'partly').map(result => result.label)
    : []
  if (needed.length > 0) {
    notes.push(
      'A replay test found the latest answer depended on these blocks. Keep the facts they ' +
      `contributed, specific values included: ${list(needed)}.`,
    )
  }
  const stale = waste.filter(item => item.kind === 'duplicate-read' || item.kind === 'stale-read').map(item => item.label)
  if (stale.length > 0) {
    notes.push(
      'These file reads are repeated or out of date, since the file changed later. Do not carry ' +
      `their old contents into the summary; at most note that the file was read: ${list(stale)}.`,
    )
  }
  const large = waste.filter(item => item.kind === 'large-output').map(item => item.label)
  if (large.length > 0) {
    notes.push(`These tool outputs were long. Keep one line each with the outcome (passed, failed, the error): ${list(large)}.`)
  }
  if (notes.length === 0) return undefined
  return ['Notes from Context Lens on what this session holds:', ...notes.map(note => `- ${note}`)].join('\n')
}

// The person's own /compact text comes first; the notes follow it.
export const withHints = (instructions: string | undefined, hints: string | undefined): string | undefined =>
  [instructions?.trim(), hints].filter(part => part !== undefined && part !== '').join('\n\n') || undefined
