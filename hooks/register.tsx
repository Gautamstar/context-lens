import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PluginOptions, Register } from 'claude-code'

import type { Ablation, AblationPlan, AblationResult, AgentRow, DropRequest, History, PaneTab, Snapshot } from '../types'
import { cacheMarks, estimateAblation, judgeText, JUDGE_LABELS, pickCandidates, promptTokens, replayPrompt, toReplay, verdictOf } from './ablation'
import type { Replay, Segment, TextBlock } from './ablation'
import { autoCompactPoint, calibrate, diff, estimateTokens, estimateTranscript, findWaste, formatTokens, LARGE_OUTPUT_TOKENS, mergeCalls, parse, readsInContext, stubResults } from './analyze'
import type { Message, Parsed } from './analyze'
import { compactionHints, editedFiles, withHints } from './hints'
import { drawPane } from './pane'

const PANE = 'context-lens'
const snapshot = atom({ plugin: 'context-lens', key: 'snapshot' } as const, null)
const ablation = atom({ plugin: 'context-lens', key: 'ablation' } as const, null)
const ablationPlan = atom({ plugin: 'context-lens', key: 'ablationPlan' } as const, null)
const history = atom({ plugin: 'context-lens', key: 'history' } as const, { points: [], turns: [], compactions: [] } as History)
const readTimes = atom({ plugin: 'context-lens', key: 'readTimes' } as const, {})
const dropRequest = atom({ plugin: 'context-lens', key: 'dropRequest' } as const, null)
const agentStats = atom({ plugin: 'context-lens', key: 'agentStats' } as const, {})
const paneTab = atom({ plugin: 'context-lens', key: 'tab' } as const, 'overview' as PaneTab)

const MAX_POINTS = 120
const MAX_TURNS = 50
const MAX_READ_TIMES = 500
// A file's modified time within this long of its read is the same moment.
const MTIME_SLACK_MS = 1000

// A pending Drop answers only the compaction it queued, which runs within this.
const DROP_WINDOW_MS = 120_000
// Read by the session.compact hook's .catch, which cannot reach $.state.
let isDropPending = false

// Where a command typed by the person comes from: the prompt, a phone or web
// client, or the desktop app and other SDK hosts.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const DROP_STUB =
  '[Context Lens removed this tool result to save context. Run the tool again if you need what it said.]'

const DEFAULT_CANDIDATES = 5
const MAX_CANDIDATES = 8
// Each replay resends the conversation, so a long one gets expensive fast.
// This also keeps Haiku under its 100k-token price step.
const MAX_REPLAY_TOKENS = 80_000

// What the person set in the plugin's options, read once per load.
type Settings = {
  autoOpen: 'in-app' | 'always' | 'never'
  // Replays go to a small model by default: each one resends most of the
  // conversation, and which blocks matter is a question a small model answers well enough.
  ablationModel: string
  largeOutputTokens: number
  compactionHints: boolean
}

const readSettings = (options: PluginOptions): Settings => {
  const autoOpen = options.autoOpen
  const threshold = Number(options.largeOutputTokens)
  return {
    autoOpen: autoOpen === 'always' || autoOpen === 'never' ? autoOpen : 'in-app',
    ablationModel: typeof options.ablationModel === 'string' && options.ablationModel !== '' ? options.ablationModel : 'haiku',
    largeOutputTokens: Number.isFinite(threshold) && threshold > 0 ? threshold : LARGE_OUTPUT_TOKENS,
    compactionHints: options.compactionHints !== false,
  }
}

let settings: Settings = readSettings({})
// Set once the pane has opened by itself, so a surface attaching later does
// not reopen a pane the person closed.
let hasAutoOpened = false

const byTokens = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens

// Reads the window and the conversation, and stores what the pane draws.
// `summary` estimates locally; `full` asks the token-count API, as /context does.
const refresh = async ($: EngineInterface, detail: 'summary' | 'full' = 'summary'): Promise<Snapshot | null> => {
  const [usage, messages, rows, stats, compactPercent] = await Promise.all([
    $.session.usage({ breakdown: detail }),
    $.session.messages({ as: 'api' }),
    $.session.messages(),
    read($, agentStats),
    $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE').catch(() => undefined),
  ])
  // The same call can appear in more than one row; one entry per call.
  const agentUses = [...new Map(rows.flatMap(row => row.toolUses ?? [])
    .filter(use => use.tool === 'Agent')
    .map(use => [use.tool_use_id, use] as const)).values()]
  const agents: AgentRow[] = agentUses.map(use => {
    const known = use.agentId === undefined ? undefined : stats[use.agentId]
    return {
      input: 0, cacheRead: 0, output: 0, runs: 0, durationMs: 0, returnedTokens: 0,
      ...known,
      agentId: use.agentId,
      toolUseId: use.tool_use_id,
      description: typeof use.input.description === 'string' ? use.input.description : 'Agent',
      agentType: typeof use.input.subagent_type === 'string' ? use.input.subagent_type : undefined,
      isRunning: known === undefined,
    }
  })
  const breakdown = usage.context.breakdown
  const raw = parse(messages as unknown as Message[])
  const exactMessages = breakdown?.categories.find(row => row.kind === 'used' && row.name === 'Messages')?.tokens
  const { blocks, factor } = calibrate(raw.blocks, exactMessages)
  const parsed: Parsed = { ...raw, blocks }
  const byId = new Map(blocks.map(block => [block.id, block]))
  const waste = findWaste(parsed, breakdown?.mcpTools ?? [], await changedOnDisk($, parsed), settings.largeOutputTokens)
  // Turns are diffed on the raw estimates, so a calibration that moves between
  // refreshes does not read as blocks added or dropped.
  const messageTokens = raw.blocks.reduce((sum, block) => sum + block.tokens, 0)
  const at = await $.clock.now()

  let stored: Snapshot | null = null
  await update($, snapshot, previous => {
    const change = diff(previous?.blockIds, previous?.messageTokens ?? 0, raw.blocks)
    stored = {
      at,
      percent: usage.context.percent ?? breakdown?.percentage,
      tokens: usage.context.tokens ?? breakdown?.totalTokens,
      window: breakdown?.rawMaxTokens ?? usage.context.window,
      categories: (breakdown?.categories ?? [])
        .filter(row => row.kind === 'used' && row.tokens > 0)
        .map(row => ({ name: row.name, tokens: row.tokens, color: row.color }))
        .sort(byTokens),
      messageTokens,
      biggest: mergeCalls(parsed.blocks).sort(byTokens).slice(0, 8),
      added: mergeCalls(change.added.map(block => byId.get(block.id) ?? block)).sort(byTokens).slice(0, 5),
      addedTokens: Math.round(change.addedTokens * factor),
      droppedTokens: Math.round(change.droppedTokens * factor),
      waste: waste.slice(0, 8),
      wasteTokens: waste.reduce((sum, item) => sum + item.tokens, 0),
      calibration: factor,
      agents: agents.slice(-8),
      autoCompactAt: breakdown?.isAutoCompactEnabled
        ? breakdown.autoCompactThreshold === undefined ? undefined : autoCompactPoint(breakdown.autoCompactThreshold, compactPercent)
        : previous?.autoCompactAt,
      editedFiles: editedFiles(rows.flatMap(row => row.toolUses ?? [])),
      blockIds: parsed.blocks.map(block => block.id),
    }
    return stored
  })

  const current = stored as Snapshot | null
  if (current) {
    const fill = current.percent === undefined ? '' : `${current.percent}% · `
    $.ui.status(`ctx ${fill}waste ${formatTokens(current.wasteTokens)}`)
  }
  return current
}

// The reads still in context whose file changed after the read finished, by
// whatever means. Reads from before the mod loaded have no time and are skipped.
const changedOnDisk = async ($: EngineInterface, parsed: Parsed): Promise<Set<string>> => {
  const times = await read($, readTimes)
  const byPath = new Map<string, string[]>()
  for (const [id, path] of readsInContext(parsed)) {
    if (times[id] !== undefined) byPath.set(path, [...(byPath.get(path) ?? []), id])
  }
  const changed = new Set<string>()
  await Promise.all([...byPath].map(async ([path, ids]) => {
    try {
      const { mtimeMs } = await $.fs.stat(path)
      for (const id of ids) if (mtimeMs > (times[id] ?? Infinity) + MTIME_SLACK_MS) changed.add(id)
    } catch {
      // Gone or unreadable: nothing to compare against.
    }
  }))
  return changed
}

// Stubs out the given tool results through a compaction this mod answers
// itself: every other message is kept exactly as the engine has it, so nothing
// is summarized. The prompt cache restarts after it, as after any compaction.
//
// It queues /compact as if the person typed it, the one way to compact that
// works in a terminal and in a headless session (the desktop app, the SDK),
// where `$.session.compact` is not available.
const dropBlocks = async ($: EngineInterface, request: Omit<DropRequest, 'at'>): Promise<string> => {
  if (isDropPending) return 'A Drop is already running.'
  isDropPending = true
  const at = await $.clock.now()
  await update($, dropRequest, () => ({ ...request, at }))
  try {
    await $.command.run({ command: 'compact' })
    const applied = (await read($, dropRequest))?.isApplied === true
    return applied
      ? `Dropped ${request.label}, about ${formatTokens(request.tokens)} tokens.`
      : 'The Drop did not run; the conversation is unchanged.'
  } catch (error) {
    return `Could not drop it now (${String(error)}). Try again once Claude is idle.`
  } finally {
    isDropPending = false
    await update($, dropRequest, () => null)
    await refresh($).catch(() => null)
  }
}

type Tally = { input: number; cached: number; output: number }

const addUsage = (tally: Tally, usage: ModelUsage | undefined) => {
  if (!usage) return
  tally.input += usage.input_tokens + usage.cache_creation_input_tokens
  tally.cached += usage.cache_read_input_tokens
  tally.output += usage.output_tokens
}

const runAblation = async ($: EngineInterface, replay: Replay, candidates: Segment[], marks: number[], model: string) => {
  const tally: Tally = { input: 0, cached: 0, output: 0 }
  const answer = async (prompt: TextBlock[]) => {
    const reply = await $.model.complete({ model, prompt, maxTokens: 400, effort: 'low' })
    addUsage(tally, reply.usage)
    return reply.isAnswered ? reply.text : undefined
  }
  const judge = async (baseline: string, other: string | undefined) =>
    other === undefined
      ? undefined
      : $.model.classify(judgeText(replay.question, baseline, other), JUDGE_LABELS).catch(() => undefined)
  const save = (change: (current: Ablation) => Ablation) =>
    update($, ablation, current =>
      current ? change({ ...current, inputTokens: tally.input, cachedTokens: tally.cached, outputTokens: tally.output }) : current)

  // The first baseline runs alone so it writes the cache every other replay reads.
  const baseline = await answer(replayPrompt(replay, marks))
  if (baseline === undefined) {
    await save(current => ({ ...current, status: 'failed', message: 'The baseline replay got no answer.' }))
    return
  }

  const noise = answer(replayPrompt(replay, marks)).then(second => judge(baseline, second))
  await Promise.all(candidates.map(async candidate => {
    const label = await judge(baseline, await answer(replayPrompt(replay, marks, candidate.id)))
    await save(current => ({
      ...current,
      results: current.results.map(result => (result.id === candidate.id ? { ...result, verdict: verdictOf(label) } : result)),
    }))
  }))
  const noiseLabel = await noise

  await save(current => ({ ...current, status: 'done', isNoisy: noiseLabel !== undefined && noiseLabel !== 'same' }))
  const needed = (await read($, ablation))?.results.filter(result => result.verdict === 'needed').length ?? 0
  $.ui.toast(`Context Lens: the last answer needed ${needed} of ${candidates.length} blocks tested.`)
}

type Prepared = { replay: Replay; candidates: Segment[]; marks: number[]; size: number }

// Checks there is something to test and that it is small enough to replay.
const prepareAblation = async ($: EngineInterface, count: number): Promise<Prepared | string> => {
  if ((await read($, ablation))?.status === 'running') return 'An ablation is already running.'
  const replay = toReplay((await $.session.messages({ as: 'api' })) as unknown as Message[])
  if (!replay) return 'Nothing to test yet: ask Claude something and let it answer first.'
  const candidates = pickCandidates(replay, count)
  if (candidates.length === 0) return 'No block before the last question is big enough to be worth testing.'
  const marks = cacheMarks(replay, candidates)
  const size = promptTokens(replayPrompt(replay, marks))
  if (size > MAX_REPLAY_TOKENS) {
    return `The conversation is about ${formatTokens(size)} tokens, more than the ${formatTokens(MAX_REPLAY_TOKENS)} ` +
      'a replay is allowed. Try again after /compact.'
  }
  return { replay, candidates, marks, size }
}

const describePlan = (plan: AblationPlan): string => {
  const cost = plan.usd === undefined ? '' : `, ${plan.usd < 0.01 ? 'under $0.01' : `up to $${plan.usd.toFixed(2)}`} at list price`
  return `${plan.replays} replays with ${plan.model} of about ${formatTokens(plan.promptTokens)} tokens each ` +
    `(${formatTokens(plan.totalTokens)} in all${cost}).`
}

// The first step of a run: works out what it would cost and waits for a yes,
// from the pane's Run button or /ctx ablate run.
const planAblation = async ($: EngineInterface, count: number): Promise<string> => {
  const prepared = await prepareAblation($, count)
  if (typeof prepared === 'string') return prepared
  const model = settings.ablationModel
  const plan: AblationPlan = { count, model, ...estimateAblation(prepared.replay, prepared.candidates, prepared.marks, model) }
  await update($, ablationPlan, () => plan)
  return `Testing ${prepared.candidates.length} blocks takes ${describePlan(plan)} Press Run in the Context Lens pane, or /ctx ablate run.`
}

const cancelAblation = async ($: EngineInterface): Promise<string> => {
  const had = (await read($, ablationPlan)) !== null
  await update($, ablationPlan, () => null)
  return had ? 'Ablation cancelled.' : 'No ablation is waiting to run.'
}

// Records the run and starts it on a timer, so the command returns at once and
// the pane fills in as replays finish. The conversation is read again here,
// so the run tests what is there now.
const startAblation = async ($: EngineInterface): Promise<string> => {
  const plan = await read($, ablationPlan)
  if (!plan) return 'Nothing to run: /ctx ablate works out the cost first.'
  await update($, ablationPlan, () => null)
  const prepared = await prepareAblation($, plan.count)
  if (typeof prepared === 'string') return prepared
  const { replay, candidates, marks } = prepared

  const results: AblationResult[] = candidates.map(({ id, label, tokens }) => ({ id, label, tokens, verdict: 'pending' }))
  const startedAt = await $.clock.now()
  await update($, ablation, () => ({
    status: 'running', startedAt, model: plan.model, question: replay.question,
    results, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
  }))
  $.clock.after(0, () => {
    runAblation($, replay, candidates, marks, plan.model).catch(error =>
      update($, ablation, current => current && { ...current, status: 'failed' as const, message: String(error) }))
  })
  return `Testing ${candidates.length} blocks with ${plan.model}. Results fill in the Context Lens pane.`
}

// The notes a normal compaction of the main conversation gets: the edits from
// the transcript being compacted, the rest from the last refresh and ablation.
const hintsFor = async (
  $: EngineInterface,
  messages: readonly { toolUses?: readonly { tool: string; input: Record<string, unknown> }[] }[],
) => {
  const [current, tested] = await Promise.all([read($, snapshot), read($, ablation)])
  return compactionHints({
    edited: editedFiles(messages.flatMap(message => message.toolUses ?? [])),
    ablation: tested,
    waste: current?.waste ?? [],
  })
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Context Lens' })

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    // Turn costs are differences of the session's total; start from where it is.
    const usd = (await $.session.usage()).cost?.usd
    await update($, history, current => ({ ...current, lastUsd: current.lastUsd ?? usd }))
    await $.command.register({
      name: 'ctx',
      description: 'Open Context Lens. "/ctx full" counts exactly, "/ctx ablate [n]" tests which blocks the last answer needed',
    })
    if (settings.autoOpen === 'always') void openPane($)
    if (settings.autoOpen === 'in-app' && (await $.session.surfaces()).some(surface => surface !== 'terminal')) {
      hasAutoOpened = true
      void openPane($)
    }
    return next(e)
  })

  // The desktop app or VS Code can attach after the session started.
  on('session.attach', async ($, e, next) => {
    if (settings.autoOpen === 'in-app' && e.surface !== 'terminal' && !hasAutoOpened) {
      hasAutoOpened = true
      void openPane($)
    }
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    await openPane($)
    const [verb, amount] = e.args.trim().split(/\s+/)
    if (verb === 'ablate') {
      if (amount === 'run') {
        // A run spends model tokens, so only the person may start it.
        if (!PERSON_ORIGINS.has(e.origin.kind)) {
          return { text: `Context Lens runs an ablation only when you start it (this came from ${e.origin.kind}).` }
        }
        return { text: await startAblation($) }
      }
      if (amount === 'cancel') return { text: await cancelAblation($) }
      const count = Math.min(MAX_CANDIDATES, Math.max(1, Number(amount) || DEFAULT_CANDIDATES))
      await update($, paneTab, () => 'ablation' as const)
      return { text: await planAblation($, count) }
    }
    const current = await refresh($, verb === 'full' ? 'full' : 'summary')
    if (!current) return { text: 'Context Lens opened.' }
    const fill = current.percent === undefined ? 'unknown' : `${current.percent}%`
    return { text: `Context ${fill} full, about ${formatTokens(current.wasteTokens)} tokens look wasted.` }
  })

  // When each Read finished, so a later change to the file shows the copy is old.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const at = await $.clock.now()
      await update($, readTimes, times =>
        Object.fromEntries(Object.entries({ ...times, [e.tool_use_id]: at }).slice(-MAX_READ_TIMES)))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A Drop answers its own compaction; every other one runs as usual and is
  // marked on the timeline.
  on('session.compact', async ($, e, next) => {
    const pending = e.agentId === undefined && (e.trigger === 'manual' || e.trigger === 'plugin')
      ? await read($, dropRequest)
      : null
    const isFresh = pending !== null && (await $.clock.now()) - pending.at < DROP_WINDOW_MS
    // While this module waits on the /compact it queued, the compaction is the
    // Drop's however late it runs; one that came from anywhere else is used
    // only within the window.
    const request = pending && !pending.isApplied && (isDropPending || isFresh) ? pending : null
    if (!request && isDropPending && e.agentId === undefined && e.trigger !== 'precompute') {
      // Never let a Drop turn into a summarizing compaction: that costs tokens
      // and rewrites far more than the person asked to remove.
      return { skip: 'Context Lens could not apply the drop, so nothing was compacted.' }
    }
    if (!request) {
      const hints = settings.compactionHints && e.agentId === undefined ? await hintsFor($, e.messages) : undefined
      const result = await next(hints === undefined ? e : { ...e, instructions: withHints(e.instructions, hints) })
      if (result.skip === undefined && e.trigger !== 'precompute' && e.agentId === undefined) {
        const at = await $.clock.now()
        await update($, history, current => ({ ...current, compactions: [...current.compactions, at].slice(-MAX_POINTS) }))
      }
      return result
    }
    const messages = stubResults(e.messages, new Set(request.blockIds), DROP_STUB)
    await update($, dropRequest, current => current && { ...current, isApplied: true })
    return { messages }
  }).catch(($, e, next) =>
    // Failing here must never turn a Drop into a full summarizing compaction.
    next.called || !isDropPending ? next(e) : { skip: 'Context Lens could not apply the drop.' })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const used = e.usage
    const agentId = e.agentId
    if (agentId !== undefined) {
      const transcript = await $.session.messages({ agentId })
      const workTokens = 'deny' in transcript ? undefined : estimateTranscript(transcript)
      await update($, agentStats, all => {
        const before = all[agentId]
        return Object.fromEntries(Object.entries({
          ...all,
          [agentId]: {
            input: (before?.input ?? 0) + (used ? used.input_tokens + used.cache_creation_input_tokens : 0),
            cacheRead: (before?.cacheRead ?? 0) + (used?.cache_read_input_tokens ?? 0),
            output: (before?.output ?? 0) + (used?.output_tokens ?? 0),
            model: used?.model ?? before?.model,
            runs: (before?.runs ?? 0) + 1,
            durationMs: (before?.durationMs ?? 0) + e.durationMs,
            returnedTokens: (before?.returnedTokens ?? 0) + estimateTokens(e.answer),
            workTokens: workTokens ?? before?.workTokens,
          },
        }).slice(-50))
      })
      await refresh($).catch(() => null)
      return result
    }
    if (e.agentId === undefined && used) {
      const [at, usage] = await Promise.all([$.clock.now(), $.session.usage()])
      const usd = usage.cost?.usd
      await update($, history, current => ({
        ...current,
        turns: [...current.turns, {
          at,
          input: used.input_tokens,
          cacheRead: used.cache_read_input_tokens,
          cacheWrite: used.cache_creation_input_tokens,
          output: used.output_tokens,
          usd: usd !== undefined && current.lastUsd !== undefined ? Math.max(0, usd - current.lastUsd) : undefined,
        }].slice(-MAX_TURNS),
        lastUsd: usd ?? current.lastUsd,
      }))
    }
    return result
  })

  // After each main-thread turn the engine re-measures; redraw when the fill moved.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      try {
        const current = await refresh($)
        if (current?.percent !== undefined) {
          const point = { at: current.at, percent: current.percent }
          await update($, history, past => ({ ...past, points: [...past.points, point].slice(-MAX_POINTS) }))
        }
      } catch (error) {
        $.ui.log(`context-lens: refresh failed: ${String(error)}`, { to: 'debug' })
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [current, tested, plan, past, tab] = await Promise.all([
      read($, snapshot), read($, ablation), read($, ablationPlan), read($, history), read($, paneTab),
    ])
    const view = { current, tested, plan, past, tab, hasHints: settings.compactionHints }
    return drawPane($.ui.resolve(e), e.surface, Math.max(24, e.props.bodyColumns), view, {
      setTab: next => void update($, paneTab, () => next),
      refresh: () => void refresh($, 'full'),
      drop: item => void dropBlocks($, { blockIds: item.blockIds, label: item.label, tokens: item.tokens }).then(text => $.ui.toast(text)),
      plan: () => void planAblation($, DEFAULT_CANDIDATES).then(text => $.ui.toast(text)),
      run: () => void startAblation($).then(text => $.ui.toast(text)),
      cancel: () => void cancelAblation($),
    })
  })
}
