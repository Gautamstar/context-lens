// One piece of the conversation the next request carries: a prompt, a reply,
// a tool call, a tool result, a reminder.
export type Block = {
  id: string
  kind: 'prompt' | 'reply' | 'reminder' | 'tool-call' | 'tool-result' | 'thinking' | 'media'
  label: string
  tokens: number
}

export type WasteKind = 'duplicate-read' | 'stale-read' | 'large-output' | 'unused-mcp'

export type Waste = {
  kind: WasteKind
  label: string
  tokens: number
  // The tool results Drop would stub out; empty for what lives outside the
  // conversation (MCP schemas).
  blockIds: string[]
}

export type Category = {
  name: string
  tokens: number
  color: string
}

export type Snapshot = {
  at: number
  percent?: number
  tokens?: number
  window: number
  categories: Category[]
  messageTokens: number
  biggest: Block[]
  added: Block[]
  addedTokens: number
  droppedTokens: number
  waste: Waste[]
  wasteTokens: number
  // Exact message tokens over the estimate; block counts are scaled by it.
  calibration: number
  // Each Agent call still in the conversation, with what it cost and returned.
  agents: AgentRow[]
  // Where auto-compaction kicks in, in tokens; absent when it is off.
  autoCompactAt?: number
  // Files this conversation edited, for the notes a compaction gets.
  editedFiles: string[]
  // What the last refresh saw, so the next one can diff against it.
  blockIds: string[]
}

// One block the ablation took out, and what that did to the answer.
export type AblationResult = {
  id: string
  label: string
  tokens: number
  verdict: 'needed' | 'partly' | 'unused' | 'failed' | 'pending'
}

export type Ablation = {
  status: 'running' | 'done' | 'failed'
  startedAt: number
  model: string
  question: string
  results: AblationResult[]
  // Two baseline runs that disagree mean the answer varies on its own, and a
  // changed answer says little about the block removed.
  isNoisy?: boolean
  // Tokens the ablation's own calls used, cache reads counted apart.
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  message?: string
}

// An ablation worked out but not started: what it would cost, waiting for a yes.
export type AblationPlan = {
  count: number
  model: string
  replays: number
  // The size of one replay's prompt, and what all of them send in total.
  promptTokens: number
  totalTokens: number
  // An estimate from list prices; undefined for a model without a known price.
  usd?: number
}

// What one subagent's runs added up to, from its turn.complete events.
export type AgentStats = {
  // Input the agent's requests sent, uncached and cache-written.
  input: number
  cacheRead: number
  output: number
  model?: string
  runs: number
  durationMs: number
  // The report it handed back: what the main conversation had to hold.
  returnedTokens: number
  // How big its own conversation grew: what the main one would have held had
  // it done the work itself.
  workTokens?: number
}

export type AgentRow = AgentStats & {
  agentId?: string
  toolUseId: string
  description: string
  agentType?: string
  isRunning: boolean
}

export type PaneTab = 'overview' | 'blocks' | 'ablation' | 'agents'

// The window's fill at one measurement, for the timeline.
export type FillPoint = { at: number; percent: number }

// What one main-loop turn cost.
export type TurnCost = {
  at: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  usd?: number
}

export type History = {
  points: FillPoint[]
  turns: TurnCost[]
  compactions: number[]
  // The session's cost total at the last turn, to work out the next turn's.
  lastUsd?: number
}

// What Drop is removing, and what it saved, for the toast afterwards. The
// compaction that applies it marks it applied.
export type DropRequest = { blockIds: string[]; label: string; tokens: number; at: number; isApplied?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-lens': {
      snapshot: Snapshot | null
      ablation: Ablation | null
      ablationPlan: AblationPlan | null
      history: History
      // When each Read in this session finished, by tool_use_id.
      readTimes: Record<string, number>
      dropRequest: DropRequest | null
      agentStats: Record<string, AgentStats>
      tab: PaneTab
    }
  }
}
