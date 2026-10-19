// The pane's drawing, apart from the hooks that feed it. Everything here turns
// a snapshot into elements; nothing reads or writes state.

import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { Ablation, AblationPlan, AblationResult, AgentRow, Block, History, PaneTab, Snapshot, Waste } from '../types'
import { formatTokens } from './analyze'
import { hintCounts } from './hints'

export type PaneActions = {
  refresh: () => void
  // An ablation is planned first, shown with its cost, then run or cancelled.
  plan: () => void
  run: () => void
  cancel: () => void
  drop: (item: Waste) => void
  setTab: (tab: PaneTab) => void
}

const MUTED = '#8A8F98'
const TEAL = '#3FB6A8'
const AMBER = '#E6A23C'
const ROSE = '#E06C8C'
const BLUE = '#5B9BF0'

const VERDICT_STYLE: Record<AblationResult['verdict'], { text: string; color: string }> = {
  needed: { text: 'needed', color: TEAL },
  partly: { text: 'partly', color: AMBER },
  unused: { text: 'unused', color: MUTED },
  failed: { text: 'failed', color: ROSE },
  pending: { text: '···', color: MUTED },
}

const WASTE_HINT: Record<Waste['kind'], string> = {
  'duplicate-read': 'Re-read',
  'stale-read': 'Stale',
  'large-output': 'Large',
  'unused-mcp': 'Idle MCP',
}

const TABS: { id: PaneTab; label: string; hotkey: string }[] = [
  { id: 'overview', label: 'Overview', hotkey: '1' },
  { id: 'blocks', label: 'Blocks', hotkey: '2' },
  { id: 'ablation', label: 'Ablation', hotkey: '3' },
  { id: 'agents', label: 'Agents', hotkey: '4' },
]

const KNOWN_TOOLS = /^(Read|Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Grep|Glob|WebFetch|Agent) (.+)$/
const MCP_TOOL = /^mcp__(.+?)__(.+)$/

// Fixed columns, in cells, so the numbers and the Drop buttons line up.
const VALUE_COLUMN = 7
const ACTION_COLUMN = 6
const VERDICT_COLUMN = 8

const SPARK = '▁▂▃▄▅▆▇█'
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

const sparkline = (percents: readonly number[]) =>
  percents.map(percent => SPARK[Math.min(SPARK.length - 1, Math.floor((percent / 100) * SPARK.length))]).join('')

// A text bar with eighth-cell precision, for the terminal.
const textBar = (fraction: number, cells: number) => {
  const eighths = Math.max(1, Math.round(Math.min(1, fraction) * cells * 8))
  return '█'.repeat(Math.floor(eighths / 8)) + PARTIAL[eighths % 8]
}

// The fill over time as a small area chart, on an absolute 0-100 scale so a
// tall chart always means a full window.
const timelineSvg = (percents: readonly number[], color: string, threshold?: number): string => {
  const W = 300
  const H = 40
  const step = percents.length > 1 ? W / (percents.length - 1) : W
  const y = (percent: number) => (H - 2 - (Math.min(100, percent) / 100) * (H - 4)).toFixed(1)
  const line = percents.map((percent, i) => `${(i * step).toFixed(1)},${y(percent)}`).join(' ')
  const limit = threshold === undefined ? ''
    : `<line x1="0" x2="${W}" y1="${y(threshold)}" y2="${y(threshold)}" stroke="${ROSE}" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">` +
    `<polygon points="0,${H} ${line} ${W},${H}" fill="${color}" fill-opacity="0.18"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
    `${limit}</svg>`
  )
}

const formatUsd = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : '<$0.01')

const percentOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

// Everything the pane draws from, read by the render hook.
export type PaneView = {
  current: Snapshot | null
  tested: Ablation | null
  plan: AblationPlan | null
  past: History
  tab: PaneTab
  // Whether compactions get Context Lens's notes (the compactionHints option).
  hasHints: boolean
}

export const drawPane = (
  els: ElementTable,
  surface: RenderSurface,
  width: number,
  view: PaneView,
  actions: PaneActions,
) => {
  const { current, tested, plan, past, tab, hasHints } = view
  const { Box, Text, Button } = els
  const isTerminal = surface === 'terminal'

  // A label that takes whatever room its row leaves and truncates at the end.
  const fill = (children: RenderChildren) => (
    <Box flexGrow={1} flexShrink={1} overflow="hidden">
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  )

  // "Read src/app.ts" and "wrap_up · ccd_turn" read best with the tool quiet.
  const label = (raw: string) => {
    const text = raw.replace(/ result$/, '')
    const mcp = MCP_TOOL.exec(text.split(' ')[0] ?? '')
    if (mcp) {
      const [, server = '', tool = ''] = mcp
      return <Text>{tool}<Text dimColor>{` · ${server}`}</Text></Text>
    }
    const known = KNOWN_TOOLS.exec(text)
    if (!known) return <Text>{text}</Text>
    const [, tool = '', target = ''] = known
    return <Text><Text dimColor>{tool} </Text>{target}</Text>
  }

  const value = (text: string, color?: string) => (
    <Box width={VALUE_COLUMN} justifyContent="flex-end" flexShrink={0}>
      <Text tabular dimColor={color === undefined} color={color}>{text}</Text>
    </Box>
  )

  const row = (key: string, left: RenderChildren, right: RenderChildren) => (
    <Box key={key} flexDirection="row" gap={1}>
      {fill(left)}
      {right}
    </Box>
  )

  const section = (key: string, title: string, aside: RenderChildren, body: RenderChildren) => (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="semibold" size="footnote">{title}</Text>
        {aside}
      </Box>
      {body}
    </Box>
  )

  const blockRow = (prefix: string, block: Block) =>
    row(`${prefix}-${block.id}`, label(block.label), value(formatTokens(block.tokens)))

  const quiet = (text: string) => <Text dimColor>{text}</Text>

  const tabBar = (
    <Box key="tabs" flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" gap={1}>
        {TABS.map(({ id, label: name, hotkey }) => {
          const count = id === 'agents' ? current?.agents.length ?? 0 : id === 'blocks' ? current?.waste.length ?? 0 : 0
          return (
            <Button
              key={`tab-${id}`}
              plain
              hotkey={hotkey}
              variant={tab === id ? 'primary' : undefined}
              label={count > 0 ? `${name} ${count}` : name}
              onPress={() => actions.setTab(id)}
            />
          )
        })}
      </Box>
      <Button key="refresh" plain label="↻" onPress={actions.refresh} />
    </Box>
  )

  if (!current) {
    return (
      <Box flexDirection="column">
        {tabBar}
        <Box marginTop={1}>{quiet('Waiting for the first prompt to measure the window.')}</Box>
      </Box>
    )
  }

  const window = current.window || 1
  const used = current.tokens ?? current.categories.reduce((sum, category) => sum + category.tokens, 0)
  const percent = current.percent ?? percentOf(used, window)
  const fillColor = percent >= 85 ? ROSE : percent >= 65 ? AMBER : undefined

  // Overview: the fill, a bar per category, the fill over time, the last turn.
  const compactAt = current.autoCompactAt
  const compactLine = compactAt === undefined ? 'Auto-compact is off'
    : used >= compactAt ? 'Past the auto-compact point'
    : `${formatTokens(compactAt - used)} until auto-compact at ${formatTokens(compactAt)}`

  const biggestCategory = current.categories[0]?.tokens ?? 1
  const barCells = Math.max(10, width - 2)
  const bar = (key: string, fraction: number, color: string) => isTerminal
    ? <Text key={key} color={color}>{textBar(fraction, barCells)}</Text>
    : (
      <Box key={key} width="100%" height={1} backgroundColor="#8A8F981F">
        <Box width={`${Math.max(1, Math.round(Math.min(1, fraction) * 100))}%`} height={1} backgroundColor={color} />
      </Box>
    )

  const header = (
    <Box key="header" flexDirection="column" marginTop={1}>
      <Text>
        <Text size="title" weight="bold" color={fillColor}>{`${percent}%`}</Text>
        <Text dimColor>{`  ${formatTokens(used)} of ${formatTokens(window)}`}</Text>
      </Text>
      <Text dimColor>{compactLine}</Text>
    </Box>
  )

  const bars = (
    <Box key="bars" flexDirection="column">
      {current.categories.map(category => (
        <Box key={`cat-${category.name}`} flexDirection="column" marginTop={1}>
          {row(`cat-row-${category.name}`,
            <Text>{category.name}</Text>,
            <Box flexDirection="row" flexShrink={0}>
              <Text tabular>{formatTokens(category.tokens)}</Text>
              <Box width={5} justifyContent="flex-end"><Text dimColor tabular>{`${percentOf(category.tokens, window)}%`}</Text></Box>
            </Box>)}
          {bar(`cat-bar-${category.name}`, category.tokens / biggestCategory, category.color)}
        </Box>
      ))}
    </Box>
  )

  const lastCost = past.turns.at(-1)
  const sessionUsd = past.turns.reduce((sum, turn) => sum + (turn.usd ?? 0), 0)
  const costLine = lastCost && (() => {
    const sent = lastCost.input + lastCost.cacheRead + lastCost.cacheWrite
    const parts = [`${formatTokens(sent)} in`, `${percentOf(lastCost.cacheRead, sent)}% cached`, `${formatTokens(lastCost.output)} out`]
    if (lastCost.usd !== undefined) parts.push(formatUsd(lastCost.usd))
    return parts.join(' · ')
  })()
  const prompts = `${past.points.length} prompt${past.points.length === 1 ? '' : 's'}`
  const percents = past.points.slice(-Math.max(10, width)).map(point => point.percent)
  const thresholdPercent = compactAt === undefined ? undefined : percentOf(compactAt, window)
  const timeline = percents.length < 2 && !lastCost ? undefined : section(
    'timeline',
    'Over time',
    <Text dimColor tabular>
      {past.compactions.length === 0 ? prompts
        : `${prompts} · ${past.compactions.length} compacted`}
    </Text>,
    <Box flexDirection="column">
      {percents.length >= 2 && (isTerminal || !('Svg' in els)
        ? <Text color={fillColor ?? BLUE}>{sparkline(percents)}</Text>
        : <els.Svg source={timelineSvg(percents, fillColor ?? BLUE, thresholdPercent)} alt={`Window fill over the last ${percents.length} prompts, now ${percent}%`} />)}
      {costLine && row('cost', <Text><Text dimColor>Last prompt </Text>{costLine}</Text>,
        sessionUsd > 0 ? <Text dimColor tabular>{`${formatUsd(sessionUsd)} total`}</Text> : <Text>{''}</Text>)}
    </Box>,
  )

  const added = current.added.filter(block => block.tokens > 0)
  const turnAside = (
    <Text tabular>
      <Text color={TEAL}>{`+${formatTokens(current.addedTokens)}`}</Text>
      {current.droppedTokens > 0 ? <Text color={MUTED}>{`  −${formatTokens(current.droppedTokens)}`}</Text> : ''}
    </Text>
  )
  const lastTurn = section('turn', 'Added by the last prompt', turnAside,
    added.length === 0
      ? quiet('Nothing new since the last refresh.')
      : added.slice(0, 4).map(block => blockRow('added', block)))

  // Blocks: what looks wasted, with Drop, then the biggest blocks.
  const waste = section('waste', 'Likely waste',
    current.wasteTokens > 0 ? <Text tabular color={AMBER}>{formatTokens(current.wasteTokens)}</Text> : quiet('none'),
    current.waste.length === 0
      ? quiet('Nothing flagged.')
      : current.waste.map((item, i) =>
        row(`waste-${i}`,
          <Text><Text color={AMBER}>{`${WASTE_HINT[item.kind]} `}</Text>{item.label}</Text>,
          <Box flexDirection="row" flexShrink={0}>
            {value(formatTokens(item.tokens))}
            <Box width={ACTION_COLUMN} justifyContent="flex-end">
              {item.blockIds.length > 0
                ? <Button key={`drop-${i}`} plain label="Drop" onPress={() => actions.drop(item)} />
                : <Text>{' '}</Text>}
            </Box>
          </Box>)))

  // What a /compact will be told, so the notes are no surprise.
  const hinted = hintCounts({ edited: current.editedFiles, ablation: tested, waste: current.waste })
  const noteParts = [
    hinted.edited > 0 && `keep ${hinted.edited} edited file${hinted.edited === 1 ? '' : 's'}`,
    hinted.needed > 0 && `keep ${hinted.needed} block${hinted.needed === 1 ? '' : 's'} the last answer needed`,
    hinted.shorten > 0 && `drop or shorten ${hinted.shorten} flagged`,
  ].filter((part): part is string => typeof part === 'string')
  const compactNotes = !hasHints ? undefined : section('notes', 'On /compact', undefined,
    quiet(noteParts.length === 0
      ? 'Nothing to add to the summary yet.'
      : `The summary is told to ${noteParts.join(', ')}.`))

  const biggest = section('big', 'Biggest blocks', quiet(`top ${Math.min(8, current.biggest.length)}`),
    current.biggest.length === 0
      ? quiet('The conversation is empty.')
      : current.biggest.filter(block => block.tokens > 0).slice(0, 8).map(block => blockRow('big', block)))

  // Ablation: which blocks the last answer needed.
  const ablateButton = (
    <Button key="ablate" plain label={tested ? '▶ Run again' : '▶ Test blocks'} onPress={actions.plan} />
  )
  const usd = plan?.usd === undefined ? '' : plan.usd < 0.01 ? ', under $0.01' : `, up to $${plan.usd.toFixed(2)}`
  const confirm = plan && (
    <Box key="confirm" flexDirection="column" marginTop={1}>
      <Text>
        {`${plan.replays} replays with ${plan.model}, ${formatTokens(plan.promptTokens)} tokens each`}
        <Text dimColor>{` (${formatTokens(plan.totalTokens)} in all${usd})`}</Text>
      </Text>
      <Box flexDirection="row" gap={2}>
        <Button key="ablate-run" plain variant="primary" label="Run" onPress={actions.run} />
        <Button key="ablate-cancel" plain label="Cancel" onPress={actions.cancel} />
      </Box>
    </Box>
  )
  const counts = (tested?.results ?? []).reduce<Record<string, number>>(
    (tally, result) => ({ ...tally, [result.verdict]: (tally[result.verdict] ?? 0) + 1 }), {})
  const summary = !tested ? undefined
    : tested.status === 'running'
      ? quiet(`Replaying with ${tested.model}: ${tested.results.length - (counts.pending ?? 0)} of ${tested.results.length} done`)
      : tested.status === 'failed'
        ? <Text color={ROSE}>{`Failed: ${tested.message ?? 'unknown error'}`}</Text>
        : (
          <Text>
            {(['needed', 'partly', 'unused'] as const).filter(verdict => counts[verdict]).map((verdict, i) => (
              <Text>
                {i > 0 ? <Text dimColor>{'  ·  '}</Text> : ''}
                <Text color={VERDICT_STYLE[verdict].color}>{`${counts[verdict]} ${verdict}`}</Text>
              </Text>
            ))}
            <Text dimColor>{`  of ${tested.results.length} tested with ${tested.model}`}</Text>
          </Text>
        )
  const ablation = section('relied', 'What the last answer needed',
    tested && tested.status !== 'running' && !plan ? ablateButton : undefined,
    !tested ? (
      <Box flexDirection="column">
        {quiet('Replays your last question with each big block removed, to see which ones the answer needed.')}
        {confirm ?? ablateButton}
      </Box>
    ) : (
      <Box flexDirection="column">
        {confirm}
        {summary}
        <Box flexDirection="column" marginTop={1}>
          {tested.results.map(result =>
            row(`ablate-${result.id}`,
              <Text>{label(result.label)}</Text>,
              <Box flexDirection="row" flexShrink={0}>
                {value(formatTokens(result.tokens))}
                <Box width={VERDICT_COLUMN} justifyContent="flex-end">
                  <Text color={VERDICT_STYLE[result.verdict].color}>{VERDICT_STYLE[result.verdict].text}</Text>
                </Box>
              </Box>))}
        </Box>
        {tested.isNoisy && (
          <Box marginTop={1}>
            <Text color={AMBER}>Two baseline replays disagreed, so the answer varies on its own. Treat these as weak signals.</Text>
          </Box>
        )}
        <Box marginTop={1}>
          {quiet(`Cost ${formatTokens(tested.inputTokens)} in, ${formatTokens(tested.cachedTokens)} cached, ${formatTokens(tested.outputTokens)} out`)}
        </Box>
      </Box>
    ))

  // Agents: what each subagent worked through in its own context, against the
  // report it handed back to this one, and what that work cost.
  const agents = current.agents
  const kept = agents.reduce((sum, agent) => sum + Math.max(0, (agent.workTokens ?? 0) - agent.returnedTokens), 0)
  const processed = agents.reduce((sum, agent) => sum + agent.input + agent.cacheRead, 0)
  const agentRow = (agent: AgentRow) => {
    const model = agent.model ? ` · ${agent.model.replace(/^claude-/, '')}` : ''
    const detail = agent.isRunning
      ? `${agent.agentType ?? 'agent'} · running`
      : `${agent.agentType ?? 'agent'}${model} · processed ${formatTokens(agent.input + agent.cacheRead)} · ${Math.round(agent.durationMs / 1000)}s`
    return (
      <Box key={`agent-${agent.toolUseId}`} flexDirection="column" marginTop={1}>
        {row(`agent-row-${agent.toolUseId}`, <Text>{agent.description}</Text>,
          agent.isRunning ? value('…')
            : <Text tabular>{formatTokens(agent.workTokens ?? 0)}<Text dimColor> → </Text>{formatTokens(agent.returnedTokens)}</Text>)}
        <Text dimColor wrap="truncate-end">{detail}</Text>
      </Box>
    )
  }
  const delegation = section('agents', 'Subagents',
    agents.length > 0 ? <Text tabular color={TEAL}>{`${formatTokens(kept)} kept out`}</Text> : undefined,
    agents.length === 0
      ? quiet('No subagents in this conversation yet.')
      : (
        <Box flexDirection="column">
          {quiet(`Work each did in its own context → what it handed back. ${formatTokens(processed)} processed in all.`)}
          {agents.map(agentRow)}
        </Box>
      ))

  const body = tab === 'blocks' ? [waste, compactNotes, biggest]
    : tab === 'ablation' ? [ablation]
    : tab === 'agents' ? [delegation]
    : [header, bars, timeline, lastTurn]

  return (
    <Box flexDirection="column">
      {tabBar}
      {body}
    </Box>
  )
}
