# Real-World Codex Comparison

This experiment compares three ways to let Codex complete the same browser
research task:

- Pure Chrome MCP: Codex receives Chrome DevTools MCP tools directly.
- Interactive REPL: Codex receives no browser MCP tools, installs the mcp2repl
  skill, and uses short shell calls into a persistent mcp2repl session.
- Prewritten REPL: Codex receives no browser MCP tools and runs a prewritten
  mcp2repl program once.

Pure Chrome MCP is the baseline. The goal is to measure whether browser
interaction can move from the model transcript into an evaluator without losing
task correctness.

## Latest Results

Model: `gpt-5.5`

[![Three-way Codex browser task comparison](../../docs/assets/real-world-time-token-comparison.jpg)](../../docs/assets/real-world-time-token-comparison.mp4)

The committed video asset shows the same task three ways: native Codex TUI on
the left and visible Chrome on the right for each variant. The final metrics bar
uses Pure Chrome MCP as the baseline.

| Metric | Pure Chrome MCP | Interactive REPL | Prewritten REPL |
| --- | ---: | ---: | ---: |
| External validation | pass | pass | pass |
| Wall-clock video time | 273.1s | 214.2s | 113.7s |
| Time vs Pure Chrome MCP | 1.00x | 0.78x | 0.42x |
| Total tokens | 1,094,568 | 175,735 | 105,970 |
| Total tokens vs Pure Chrome MCP | 1.00x | 0.16x | 0.10x |
| Total token reduction vs Pure Chrome MCP | baseline | 83.9% less | 90.3% less |
| Uncached input + output | 66,728 | 18,807 | 13,298 |
| Uncached tokens vs Pure Chrome MCP | 1.00x | 0.28x | 0.20x |
| Uncached reduction vs Pure Chrome MCP | baseline | 71.8% less | 80.1% less |
| Top-level operations | 23 MCP tool calls | 3 shell commands + 1 file edit | 1 shell command |
| Codex MCP injected | yes | no | no |
| mcp2repl skill installed | no | yes | yes |

Run records:

| Variant | Timestamp | Input | Cached input | Uncached input | Output | Reasoning output | Total | Uncached total | Item types |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| pure-mcp | `2026-05-14T11-05-39-671Z` | 1,088,773 | 1,027,840 | 60,933 | 5,795 | 1,032 | 1,094,568 | 66,728 | `{"agent_message":4,"mcp_tool_call":23}` |
| interactive-repl | `2026-05-14T14-33-00-641Z` | 170,573 | 156,928 | 13,645 | 5,162 | 696 | 175,735 | 18,807 | `{"agent_message":5,"command_execution":3,"file_change":1}` |
| scripted-repl | `2026-05-14T11-12-32-851Z` | 101,308 | 92,672 | 8,636 | 4,662 | 51 | 105,970 | 13,298 | `{"command_execution":1,"agent_message":1}` |

## Task

The task is deliberately ordinary and browser-heavy: help a normal buyer choose
a MacBook for remote work, many browser tabs, video calls, light photo editing,
occasional travel, and several years of useful life.

Constraints:

- Use public Apple pages only.
- Do not log in.
- Do not add anything to cart or checkout.
- Do not enter personal information.
- Do not use direct HTTP clients, curl, wget, Python requests, or browserless
  scraping.
- Use visible Chrome through Chrome DevTools MCP.

Pages:

- `https://www.apple.com/macbook-air/`
- `https://www.apple.com/macbook-pro/`
- `https://www.apple.com/mac/compare/`
- `https://www.apple.com/us/shop/buy-mac/macbook-air`
- `https://www.apple.com/us/shop/buy-mac/macbook-pro`

Required options:

- 13-inch MacBook Air with at least 16GB memory and 512GB storage.
- 15-inch MacBook Air with at least 16GB memory and 512GB storage.
- 14-inch MacBook Pro with at least 16GB memory and 512GB storage.

The expected answer is compact JSON with product name, official URL, visible or
configured price, chip, memory, storage, display, portability, battery/power
claim, ports, tradeoffs, recommendation fields, source URLs, and
`invariantPassed`.

## Variant Control

All variants are launched by `run.mjs` with isolated Codex homes under the run
artifact directory. The runner copies authentication files but ignores the
user's normal MCP config, skills, and local session state.

Pure Chrome MCP:

- `codexMcpInjected: true`
- `skillInstalled: false`
- Configures `mcp_servers.chrome-devtools` for Codex.
- Codex must use Chrome/browser MCP tools directly.
- Codex is forbidden from shell commands, direct HTTP clients, and external
  scrapers.

Interactive REPL:

- `codexMcpInjected: false`
- `skillInstalled: true`
- Codex has shell access but no browser MCP tools.
- The runner sets `MCP2REPL_*` defaults for config, server, session, JSON
  output, timeout, max output, and artifact directory.
- Codex is instructed to create one evaluator-side task module that defines
  compound procedures on `globalThis`.
- It should load the task module into the persistent evaluator environment,
  then evaluate medium-sized procedures such as setup, observe one page slice,
  compose, validate, and repair only missing fields.
- Browser loops, retries, DOM extraction, and artifact handling should run
  inside those compound procedures.

Prewritten REPL:

- `codexMcpInjected: false`
- `skillInstalled: true`
- Codex runs `scripted-repl-task.js` once through mcp2repl.
- Codex must return the exact JSON object printed by the command.
- This measures the amortized cost once the compound procedures are already
  code.

## Validation

The experiment records Codex's `invariantPassed` field and also applies an
external validator in `run.mjs`.

The external validator requires:

- A JSON result with `invariantPassed: true`.
- At least three options.
- Distinct 13-inch Air, 15-inch Air, and 14-inch Pro identities.
- Price above `$900` for every option.
- Non-empty product name, official URL, chip, memory, and storage.
- At least two evidence facts per option.
- Page-like evidence mentioning MacBook, chip, memory, storage, display,
  battery, ports, MagSafe, Thunderbolt, or a dollar price.
- Different 13-inch and 15-inch Air prices.

This catches common failure modes: using one broad page blob for all products,
copying the 13-inch Air price into the 15-inch Air, returning unknown memory or
storage, and using generic fallback facts.

## Reproduction

Run one variant at a time:

```bash
CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=pure-mcp npm run experiment:real-world

CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=interactive-repl npm run experiment:real-world

CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=scripted-repl npm run experiment:real-world
```

Run all variants:

```bash
CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  npm run experiment:real-world
```

## Recording

To record the observable run, start a visible Chrome with remote debugging and
use the composite recorder:

```bash
npm run record:real-world:composite -- pure-mcp
npm run record:real-world:composite -- interactive-repl
npm run record:real-world:composite -- scripted-repl
```

The composite recorder captures the real Codex terminal stream with
`asciinema`, captures the same visible Chrome through CDP screencast, and writes
a side-by-side MP4 to
`.tmp/recordings/<timestamp>-<variant>-composite/composite.mp4`. The left side
is native Codex TUI; the right side is the Chrome operation process.

Older recording helpers remain available for debugging:

```bash
npm run record:real-world -- pure-mcp
npm run record:real-world -- interactive-repl
npm run record:real-world -- scripted-repl

npm run record:real-world:native-tui -- pure-mcp
npm run record:real-world:native-tui -- interactive-repl
npm run record:real-world:native-tui -- scripted-repl
```

The dashboard recorder (`record:real-world`) reformats Codex output in HTML.
The native-only recorder (`record:real-world:native-tui`) captures the real TUI
but does not include Chrome. Use the composite recorder for comparison videos.

Composite recordings from May 14, 2026:

| Variant | Composite MP4 | Duration | External validation |
| --- | --- | ---: | --- |
| Pure Chrome MCP | `.tmp/recordings/20260514T124702Z-pure-mcp-composite/composite.mp4` | 273.1s | pass |
| Interactive REPL | `.tmp/recordings/20260514T142842Z-interactive-repl-composite/composite.mp4` | 214.2s | pass |
| Prewritten REPL | `.tmp/recordings/20260514T125801Z-scripted-repl-composite/composite.mp4` | 113.7s | pass |

Final comparison video:

| Artifact | What it shows |
| --- | --- |
| `docs/assets/real-world-time-token-comparison.mp4` | Committed README video asset. Use this when viewing the project on GitHub or sharing the result. |
| `.tmp/recordings/20260514T143809Z-three-way-comparison/final-time-token-comparison.mp4` | Three synchronized rows with a persistent top metrics bar. The bar aligns wall-clock time with total token usage: Pure Chrome MCP is the baseline, Interactive REPL is 21.6% faster and uses 83.9% fewer tokens, and Prewritten REPL is 58.4% faster and uses 90.3% fewer tokens. |

The interactive recording reuses the visible Apple tab instead of creating a
hidden/new page. Its `selected-targets.log` shows the same target navigating
through Apple, MacBook Air, MacBook Pro, Mac compare, and both public buy
pages, so the Chrome pane is the actual browser work rather than a stale page.

Each composite directory also includes `terminal/codex.cast`,
`terminal/codex.mp4`, `browser/recording.mp4`, `sample.jpg`, and
`recording.json`. The `sample.jpg` frame is a quick visual check that the
recording contains both the native TUI and Chrome operation pane.

These recordings are for process and elapsed-time inspection. Token accounting
requires the default JSONL mode from `npm run experiment:real-world`; TUI mode
does not expose Codex usage events, so those summary tables intentionally show
zero tokens.

Useful files:

- `run.mjs`: experiment runner, Codex isolation, variant setup, usage parsing,
  validation, and markdown summary generation.
- `prompt.txt`: shared task prompt with variant-specific instructions inserted
  at runtime.
- `scripted-repl-task.js`: prewritten REPL program used by the scripted arm.
- `record-variant.mjs`: starts dashboard recording and runs one Codex variant in
  TUI mode.
- `record-composite.mjs`: records native Codex TUI and visible Chrome side by
  side.
- `record-native-tui.mjs`: records the native Codex PTY output with asciinema
  and renders it to MP4.
- `record-dashboard.mjs`: records a dashboard with Codex TUI output, live
  browser screenshots, and elapsed time.
- `.tmp/real-world-codex-comparison/<timestamp>/summary.md`: per-run summary.
- `.tmp/real-world-codex-comparison/<timestamp>/*.jsonl`: Codex JSONL
  transcript for the run.
- `.tmp/real-world-codex-comparison/<timestamp>/*.result.txt`: final answer.
- `.tmp/real-world-codex-comparison/<timestamp>/*.prompt.txt`: rendered prompt.

## Notes

The experiment is intentionally strict about control variables:

- Pure MCP does not get the mcp2repl skill.
- REPL variants do not get browser MCP tools injected into Codex.
- The mcp2repl skill is installed only into the isolated run home, not assumed
  globally.
- Chrome is launched with US English arguments.
- Interactive REPL commands are short because `MCP2REPL_*` env defaults carry
  stable configuration.

The key finding is not that the prewritten script wins; that is expected. The
important result is that the interactive REPL path, where Codex still writes and
repairs task code during the run, uses far fewer tokens than direct Chrome MCP
while passing the same external validator.
