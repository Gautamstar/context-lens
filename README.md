# Context Lens

A Claude Code plugin that shows what's in your context window and which tokens are going to waste.

<p>
  <img src="docs/overview.png" alt="Overview tab" width="49%">
  <img src="docs/blocks.png" alt="Blocks tab" width="49%">
</p>

## Install

```
/plugin install context-lens --marketplace Gautamstar/context-lens
```

In the desktop app, click + next to the prompt box, then Plugins, and add the marketplace `Gautamstar/context-lens`.

Needs Claude Code 2.1.299 or later. The plugin API is still early access, so a Claude Code update can break it.

## Tabs

Overview shows how full the window is, token use by category, fill over time, and what the last prompt cost.

Blocks lists likely waste: files read more than once, reads of files that changed afterwards, tool outputs over 5k tokens, and MCP tools that were never called. Drop removes one of these from the conversation without summarizing anything else. It resets the prompt cache, so the next prompt costs more.

Ablation replays your last question with each big block removed and shows which ones changed the answer. It shows an estimated cost first and waits for you to press Run. The replays run on Haiku over a flattened transcript, so treat the results as hints.

Agents compares how much each subagent read with how much it sent back.

Per-block token counts are estimates.

Only the ablation calls a model, and only after you press Run or type `/ctx ablate run` yourself. Nothing else in Context Lens spends tokens.

## Compaction notes

When you run `/compact` or auto-compact kicks in, Context Lens tells the summarizer which files were edited and which reads are stale. This and Drop don't run where an organization manages Claude Code.

## Commands

| Command | |
| --- | --- |
| `/ctx` | Open the pane |
| `/ctx full` | Recount with the token-counting API |
| `/ctx ablate [n]` | Estimate the cost of testing the `n` biggest blocks (default 5) |
| `/ctx ablate run` | Run it |
| `/ctx ablate cancel` | Cancel it |

## Settings

Set these in `/config`.

| Setting | Default | |
| --- | --- | --- |
| `autoOpen` | `in-app` | Open the pane at startup in the desktop app and VS Code. Also `always` or `never`. |
| `ablationModel` | `haiku` | Model for ablation replays. `sonnet` costs about 20x more. |
| `largeOutputTokens` | `5000` | Size at which a tool output counts as waste. |
| `compactionHints` | on | Add the compaction notes. |

## Development

```bash
claude --plugin-dir ./context-lens
```

```bash
claude plugin test ./context-lens
```

## License

MIT
