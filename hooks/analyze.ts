// Pure analysis of the conversation: no `$`, so the tests can feed it
// hand-built messages.

import type { Block, Waste } from '../types'

export type ContentBlock = { type: string; [field: string]: unknown }
export type Message = { role: 'user' | 'assistant'; content: ContentBlock[] }
export type McpTool = { name: string; serverName: string; tokens: number; isLoaded: boolean }

// Roughly four characters per token for English and code. Good enough to rank
// blocks against each other; /context's own figures stay the authority.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

// What the API charges for an image or a PDF page is size dependent; this is a
// typical figure for a screenshot.
const MEDIA_TOKENS = 1600

export const LARGE_OUTPUT_TOKENS = 5000

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type ToolUse = { name: string; input: Record<string, unknown>; index: number }

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

const normalizePath = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

const shortPath = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

// A one-line name for a tool call, so a list of blocks reads like a log.
export const describeCall = (name: string, input: Record<string, unknown>): string => {
  if (FILE_TOOLS.has(name)) return `${name} ${shortPath(str(input.file_path) || str(input.notebook_path))}`
  if (name === 'Bash' || name === 'PowerShell') return `${name} ${clip(str(input.command), 40)}`
  if (name === 'Grep' || name === 'Glob') return `${name} ${clip(str(input.pattern), 40)}`
  if (name === 'WebFetch') return `WebFetch ${clip(str(input.url), 40)}`
  if (name === 'Agent') return `Agent ${clip(str(input.description), 40)}`
  return name
}

const resultText = (content: unknown): { text: string; media: number } => {
  if (typeof content === 'string') return { text: content, media: 0 }
  if (!Array.isArray(content)) return { text: '', media: 0 }
  let text = ''
  let media = 0
  for (const part of content as ContentBlock[]) {
    if (part.type === 'text') text += str(part.text)
    else if (part.type === 'image' || part.type === 'document') media += 1
  }
  return { text, media }
}

export type Parsed = {
  blocks: Block[]
  // Which call each tool result answers, by tool_use_id.
  calls: Map<string, ToolUse>
  // Where each block sits in the conversation, for "did X happen after Y".
  order: Map<string, number>
}

export const parse = (messages: readonly Message[]): Parsed => {
  const blocks: Block[] = []
  const calls = new Map<string, ToolUse>()
  const order = new Map<string, number>()
  let index = 0

  const push = (block: Block) => {
    blocks.push(block)
    order.set(block.id, index++)
  }

  messages.forEach((message, m) => {
    message.content.forEach((part, b) => {
      const id = `m${m}.${b}`
      if (part.type === 'text') {
        const text = str(part.text)
        const isReminder = message.role === 'user' && text.trimStart().startsWith('<system-reminder>')
        const kind = isReminder ? 'reminder' : message.role === 'user' ? 'prompt' : 'reply'
        const label = isReminder ? 'System reminder' : `${kind === 'prompt' ? 'You' : 'Claude'}: ${clip(text, 50)}`
        push({ id, kind, label, tokens: estimateTokens(text) })
      } else if (part.type === 'thinking') {
        push({ id, kind: 'thinking', label: 'Thinking', tokens: estimateTokens(str(part.thinking)) })
      } else if (part.type === 'tool_use') {
        const name = str(part.name)
        const input = (part.input ?? {}) as Record<string, unknown>
        const useId = str(part.id) || id
        calls.set(useId, { name, input, index })
        push({ id: `${useId}:call`, kind: 'tool-call', label: describeCall(name, input), tokens: estimateTokens(JSON.stringify(input)) })
      } else if (part.type === 'tool_result') {
        const useId = str(part.tool_use_id)
        const call = calls.get(useId)
        const { text, media } = resultText(part.content)
        push({
          id: useId || id,
          kind: 'tool-result',
          label: call ? `${describeCall(call.name, call.input)} result` : 'Tool result',
          tokens: estimateTokens(text) + media * MEDIA_TOKENS,
        })
      } else if (part.type === 'image' || part.type === 'document') {
        push({ id, kind: 'media', label: part.type === 'image' ? 'Image' : 'Document', tokens: MEDIA_TOKENS })
      }
    })
  })

  return { blocks, calls, order }
}

// The Read calls whose results are still in the conversation, by tool_use_id,
// with the file each one read: what the disk check stats.
export const readsInContext = (parsed: Parsed): Map<string, string> => {
  const reads = new Map<string, string>()
  for (const block of parsed.blocks) {
    const call = block.kind === 'tool-result' ? parsed.calls.get(block.id) : undefined
    if (call?.name === 'Read' && str(call.input.file_path)) reads.set(block.id, str(call.input.file_path))
  }
  return reads
}

// Tokens the next request pays for that probably do nothing for the model.
// Each block is counted at most once, under the first rule that claims it.
// `changedOnDisk` names reads whose file changed after they ran, by any means
// (a Bash command, a formatter, an editor), which the transcript cannot show.
export const findWaste = (
  parsed: Parsed,
  mcpTools: readonly McpTool[] = [],
  changedOnDisk: ReadonlySet<string> = new Set(),
  largeOutputTokens = LARGE_OUTPUT_TOKENS,
): Waste[] => {
  const { blocks, calls, order } = parsed
  const waste: Waste[] = []
  const claimed = new Set<string>()

  // `path` compares (case and slashes folded); `shown` is how the call spelled it.
  const reads: { block: Block; key: string; path: string; shown: string; at: number }[] = []
  const editedAt = new Map<string, number[]>()
  for (const [, call] of calls) {
    if (!EDIT_TOOLS.has(call.name)) continue
    const path = normalizePath(str(call.input.file_path) || str(call.input.notebook_path))
    editedAt.set(path, [...(editedAt.get(path) ?? []), call.index])
  }
  for (const block of blocks) {
    if (block.kind !== 'tool-result') continue
    const call = calls.get(block.id)
    if (call?.name !== 'Read') continue
    const path = normalizePath(str(call.input.file_path))
    // The same range of the same file; a different offset is a different read.
    const key = `${path}|${String(call.input.offset ?? '')}|${String(call.input.limit ?? '')}`
    reads.push({ block, key, path, shown: str(call.input.file_path), at: order.get(block.id) ?? 0 })
  }

  // The same file range read more than once: every copy but the newest.
  const byKey = new Map<string, typeof reads>()
  for (const read of reads) byKey.set(read.key, [...(byKey.get(read.key) ?? []), read])
  for (const group of byKey.values()) {
    const first = group[0]
    if (first === undefined || group.length < 2) continue
    const older = group.slice(0, -1)
    older.forEach(read => claimed.add(read.block.id))
    waste.push({
      kind: 'duplicate-read',
      label: `${shortPath(first.shown)} read ${group.length} times`,
      tokens: older.reduce((sum, read) => sum + read.block.tokens, 0),
      blockIds: older.map(read => read.block.id),
    })
  }

  // A read the file has since changed past: the model is holding an old copy.
  for (const read of reads) {
    if (claimed.has(read.block.id)) continue
    const isEdited = (editedAt.get(read.path) ?? []).some(at => at > read.at)
    if (!isEdited && !changedOnDisk.has(read.block.id)) continue
    claimed.add(read.block.id)
    waste.push({
      kind: 'stale-read',
      label: `${shortPath(read.shown)} ${isEdited ? 'edited' : 'changed on disk'} after it was read`,
      tokens: read.block.tokens,
      blockIds: [read.block.id],
    })
  }

  // One tool result big enough to matter on its own.
  for (const block of blocks) {
    if (block.kind !== 'tool-result' || claimed.has(block.id)) continue
    if (calls.get(block.id)?.name === 'Read' || block.tokens < largeOutputTokens) continue
    claimed.add(block.id)
    waste.push({ kind: 'large-output', label: block.label.replace(/ result$/, ''), tokens: block.tokens, blockIds: [block.id] })
  }

  // MCP tool schemas sent every turn for tools this conversation never called.
  const called = new Set([...calls.values()].map(call => call.name))
  const unusedByServer = new Map<string, { tokens: number; count: number }>()
  for (const tool of mcpTools) {
    if (!tool.isLoaded || called.has(tool.name)) continue
    const entry = unusedByServer.get(tool.serverName) ?? { tokens: 0, count: 0 }
    unusedByServer.set(tool.serverName, { tokens: entry.tokens + tool.tokens, count: entry.count + 1 })
  }
  for (const [server, { tokens, count }] of unusedByServer) {
    // Connectors are often named by an id; its first group is enough to tell them apart.
    const name = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(server) ? `${server.slice(0, 8)}…` : server
    waste.push({ kind: 'unused-mcp', label: `${name} · ${count} unused tool${count === 1 ? '' : 's'}`, tokens, blockIds: [] })
  }

  return waste.sort((a, b) => b.tokens - a.tokens)
}

// Scales the per-block estimates so they add up to Claude Code's own count of
// the messages, keeping their ranking. Clamped, so one bad reading cannot
// stretch every block tenfold.
export const calibrate = (blocks: readonly Block[], exactTokens: number | undefined): { blocks: Block[]; factor: number } => {
  const estimated = blocks.reduce((sum, block) => sum + block.tokens, 0)
  if (!exactTokens || estimated === 0) return { blocks: [...blocks], factor: 1 }
  const factor = Math.min(4, Math.max(0.25, exactTokens / estimated))
  return { blocks: blocks.map(block => ({ ...block, tokens: Math.round(block.tokens * factor) })), factor }
}

// A tool call and its result as one row: what a person thinks of as "the Read
// of app.ts", instead of a tiny call block beside a big result block.
export const mergeCalls = (blocks: readonly Block[]): Block[] => {
  const results = new Set(blocks.filter(block => block.kind === 'tool-result').map(block => block.id))
  const callTokens = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind === 'tool-call' && results.has(block.id.replace(/:call$/, ''))) {
      callTokens.set(block.id.replace(/:call$/, ''), block.tokens)
    }
  }
  return blocks
    .filter(block => !(block.kind === 'tool-call' && callTokens.has(block.id.replace(/:call$/, ''))))
    .map(block =>
      block.kind === 'tool-result' && callTokens.has(block.id)
        ? { ...block, label: block.label.replace(/ result$/, ''), tokens: block.tokens + (callTokens.get(block.id) ?? 0) }
        : block)
}

// A transcript's size as the rows `$.session.messages()` returns: text, tool
// inputs and tool results, estimated the same way as the main conversation.
export type TranscriptRow = {
  text: string
  toolUses: readonly { input: Record<string, unknown>; text?: string }[]
  toolResults?: readonly { text: string }[]
}

export const estimateTranscript = (rows: readonly TranscriptRow[]): number =>
  rows.reduce((sum, row) =>
    sum + estimateTokens(row.text) +
    row.toolUses.reduce((uses, use) => uses + estimateTokens(JSON.stringify(use.input)) + estimateTokens(use.text ?? ''), 0) +
    (row.toolResults ?? []).reduce((results, result) => results + estimateTokens(result.text), 0), 0)

// The rows a compaction hands a hook, as far as Drop needs them.
export type CompactRow = {
  toolResults?: readonly { tool_use_id: string; text: string; isError: boolean }[]
  handle?: string
}

// Replaces the named tool results with `stub` and leaves every other message
// exactly as it was, handle and all. A message that changed loses its handle,
// which tells the engine to rebuild it from these fields.
export const stubResults = <R extends CompactRow>(rows: readonly R[], ids: ReadonlySet<string>, stub: string): R[] =>
  rows.map(row => {
    if (!row.toolResults?.some(result => ids.has(result.tool_use_id))) return row
    const { handle: _handle, ...rest } = row
    return {
      ...rest,
      toolResults: row.toolResults.map(result =>
        ids.has(result.tool_use_id) ? { tool_use_id: result.tool_use_id, text: stub, isError: false } : result),
    } as unknown as R
  })

export type Diff = { added: Block[]; addedTokens: number; droppedTokens: number }

// What changed since the last refresh. Blocks keep their ids from one turn to
// the next, so anything new is what this turn added; a compaction shows up as
// a large drop.
export const diff = (previousIds: readonly string[] | undefined, previousTokens: number, blocks: readonly Block[]): Diff => {
  if (previousIds === undefined) return { added: [], addedTokens: 0, droppedTokens: 0 }
  const seen = new Set(previousIds)
  const added = blocks.filter(block => !seen.has(block.id))
  const addedTokens = added.reduce((sum, block) => sum + block.tokens, 0)
  const kept = blocks.reduce((sum, block) => sum + block.tokens, 0) - addedTokens
  return { added, addedTokens, droppedTokens: Math.max(0, previousTokens - kept) }
}

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
  : tokens >= 10_000 ? `${Math.round(tokens / 1000)}k`
  : tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
  : String(tokens)
