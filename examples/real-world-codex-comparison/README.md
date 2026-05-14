# Real-World Codex Comparison

This experiment compares three process abstractions for the same visible-browser
task:

- Pure Chrome MCP: Codex receives Chrome DevTools MCP tools directly.
- Interactive REPL: Codex receives no browser MCP tools, installs the static
  mcp2repl skill, and drives Chrome through small evaluator expressions.
- Prewritten REPL: Codex receives no browser MCP tools and runs one reusable
  mcp2repl program.

The point is not to hide the task in a script. The interactive path follows a
procedure-abstraction discipline: MCP tools are primitive procedures, thin
helpers are compound procedures, the mcp2repl session is the environment, and
each step returns a compact typed checkpoint before the next step is chosen.

## Latest Strict Data

Model: `gpt-5.5`

All rows use the same accounting source: Codex JSONL usage events recorded by
`run.mjs`. Each row below is the latest strict pass for that variant after the
procedure-abstraction prompt was tightened to avoid setup-only pauses, repair
churn, and extra final export commands.

Run artifacts:

- Pure Chrome MCP: `.tmp/real-world-codex-comparison/2026-05-14T22-06-31-970Z`
- Interactive REPL: `.tmp/real-world-codex-comparison/2026-05-14T22-13-13-600Z`
- Prewritten REPL: `.tmp/real-world-codex-comparison/2026-05-14T22-15-09-411Z`

| Metric | Pure Chrome MCP | Interactive REPL | Prewritten REPL |
| --- | ---: | ---: | ---: |
| Process abstraction | direct tool calls | small evaluator steps | reusable compound procedure |
| External validation | pass | pass | pass |
| Failed transcript items | 0 | 0 | 0 |
| Input tokens | 2,006,967 | 133,693 | 49,448 |
| Cached input tokens | 1,882,496 | 117,632 | 44,800 |
| Uncached input tokens | 124,471 | 16,061 | 4,648 |
| Output tokens | 5,480 | 3,937 | 1,181 |
| Reasoning output tokens | 1,232 | 0 | 99 |
| Total tokens | 2,012,447 | 137,630 | 50,629 |
| Total tokens vs Pure Chrome MCP | 1.00x | 0.068x | 0.025x |
| Token advantage | baseline | 14.62x fewer | 39.75x fewer |
| Total token reduction | baseline | 93.2% less | 97.5% less |
| Uncached input + output | 129,951 | 19,998 | 5,829 |
| Uncached token advantage | baseline | 6.50x fewer | 22.29x fewer |
| Uncached reduction | baseline | 84.6% less | 95.5% less |
| Strict JSONL elapsed | 175.5s | 105.1s | 51.8s |
| Time vs Pure Chrome MCP | 1.00x | 0.60x | 0.30x |
| Time advantage | baseline | 1.67x faster | 3.39x faster |
| Top-level operations | 27 MCP tool calls | 4 evaluator commands | 1 evaluator command |
| Item types | `{"mcp_tool_call":27,"agent_message":1}` | `{"command_execution":4,"agent_message":1}` | `{"agent_message":2,"command_execution":1}` |
| Codex MCP injected | yes | no | no |
| mcp2repl skill installed | no | yes | yes |

## Step Timing

The strict JSONL recorder timestamps every action event when it is received.
This makes total time and per-step distribution comparable across variants.

| Metric | Pure Chrome MCP | Interactive REPL | Prewritten REPL |
| --- | ---: | ---: | ---: |
| Action steps | 27 | 4 | 1 |
| First action | 13.9s | 14.3s | 16.0s |
| Median action | 0.8s | 1.1s | 16.9s |
| P90 action | 3.1s | 7.7s | 16.9s |
| Max action duration | 6.7s | 7.7s | 16.9s |
| Max gap between actions | 8.5s | 21.6s | 0.0s |
| Slowest actions | `evaluate_script:6.7s, evaluate_script:3.7s, evaluate_script:3.1s` | `mcp2repl stdin eval:7.7s, mcp2repl stdin eval:5.8s, mcp2repl stdin eval:1.1s` | `mcp2repl stdin eval:16.9s` |

The interactive REPL result is now faster both in total and at the evaluator
action layer: it has no setup-only command, no failed repair step, and no
separate final export command. Its remaining non-uniformity is the 21.6s
model-composition gap between evaluator steps. That gap is not browser work; it
is Codex writing the next compound procedure.

## Recorded Process Video

[![Three-way Codex browser task comparison](../../docs/assets/real-world-time-token-comparison.jpg)](../../docs/assets/real-world-time-token-comparison.mp4)

The committed video shows native Codex TUI on the left and visible Chrome on the
right for each variant. It is a qualitative process recording, not the token
accounting source. Native TUI recording uses human-readable output and may take
longer or behave differently from non-human JSONL runs. Use the strict JSONL
tables above for benchmark claims.

Final video artifacts:

- `docs/assets/real-world-time-token-comparison.mp4`: committed README video.
- `docs/assets/real-world-time-token-comparison.jpg`: committed preview frame.
- `.tmp/recordings/20260514T220100Z-three-way-comparison/final-time-token-comparison.web.mp4`: local compressed stitched source used for docs.

## Task

The task is deliberately ordinary and browser-heavy: help a normal buyer choose
a MacBook for remote work, many browser tabs, video calls, light photo editing,
occasional travel, and several years of useful life.

Constraints:

- Use public Apple pages only.
- Use US/English Apple pages.
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

The expected answer is compact JSON with product name, official URL, price,
chip, memory, storage, display, portability, battery/power claim, ports,
tradeoffs, recommendation fields, source URLs, and `invariantPassed`.

## Procedure Abstraction

The comparison is about the shape of tool use.

Pure Chrome MCP keeps every browser action as a top-level tool call. That is a
direct process: observe, decide, call a tool, observe again. It is simple, but
large Chrome observations and tool schemas remain close to the model transcript.

Interactive REPL moves browser operation into an evaluator while preserving
exploration. The agent chooses a step of the right size:

- Discover only the primitive procedures it needs.
- Bootstrap the evaluator and perform the first real browser action in the same
  command.
- Define thin helpers such as `go(url)` and `evalPage(fn, args)`.
- Navigate one public Apple page or product slice at a time.
- Return only typed facts, missing fields, and source URLs.
- Keep raw text, retries, aggregation, and page-specific loops in the evaluator.
- Return the final JSON from the final synthesis step instead of doing a second
  export command.

Prewritten REPL measures the amortized path after exploration has become a
reusable compound procedure. It is expected to be cheapest; it is not a
replacement for the interactive path.

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
- Codex uses the installed static skill only for discovery and workflow
  guidance.
- Dynamic tool context is queried inside the REPL with `api.searchTools()`,
  `api.guide()`, `api.library()`, and `api.describeTool()` when needed.
- Work must proceed as small evaluator expressions, not one broad script and
  not one shell command per primitive browser call.

Prewritten REPL:

- `codexMcpInjected: false`
- `skillInstalled: true`
- Codex runs `scripted-repl-task.js` once through mcp2repl.
- Codex must return the exact JSON object printed by the command.
- This measures the reusable-code endpoint after exploration.

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

Run the strict three-way comparison with a visible Chrome listening on
`127.0.0.1:9223`:

```bash
CODEX_MODEL=gpt-5.5 \
CODEX_ATTEMPTS=2 \
CODEX_RETRY_DELAY_MS=30000 \
CODEX_VARIANTS=pure-mcp,interactive-repl,scripted-repl \
REAL_WORLD_CHROME_BROWSER_URL=http://127.0.0.1:9223 \
REAL_WORLD_CHROME_CONFIG=.tmp/recordings/chrome-devtools-browserurl.json \
npm run experiment:real-world
```

Create `.tmp/recordings/chrome-devtools-browserurl.json` with:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browserUrl=http://127.0.0.1:9223",
        "--no-usage-statistics",
        "--no-performance-crux"
      ]
    }
  }
}
```

If visible Chrome recording is not needed, omit `REAL_WORLD_CHROME_BROWSER_URL`
and `REAL_WORLD_CHROME_CONFIG`; the runner launches an isolated en-US Chrome via
`chrome-devtools-mcp`.

Run one variant only:

```bash
CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=interactive-repl npm run experiment:real-world
```

Artifacts are written under `.tmp/real-world-codex-comparison/<timestamp>/`.
Each run writes the rendered prompt, isolated Codex home, JSONL transcript,
raw JSONL transcript, final result, and `summary.md`.

## Recording

The composite recorder captures native Codex TUI with `asciinema`, captures
visible Chrome through CDP screencast, and writes a side-by-side MP4.

```bash
CODEX_MODEL=gpt-5.5 npm run record:real-world:composite -- pure-mcp
CODEX_MODEL=gpt-5.5 npm run record:real-world:composite -- interactive-repl
CODEX_MODEL=gpt-5.5 npm run record:real-world:composite -- scripted-repl
```

Each composite directory includes:

- `terminal/codex.cast`
- `terminal/codex.mp4`
- `browser/recording.mp4`
- `composite.mp4`
- `recording.json`

The dashboard recorder reformats Codex output in HTML. The native-only recorder
captures the real TUI but does not include Chrome. Use the composite recorder
for comparison videos.

## Useful Files

- `run.mjs`: experiment runner, Codex isolation, variant setup, usage parsing,
  validation, and summary generation.
- `prompt.txt`: shared task prompt with variant-specific capability
  instructions inserted at runtime.
- `scripted-repl-task.js`: prewritten REPL program used by the scripted arm.
- `record-composite.mjs`: records native Codex TUI and visible Chrome side by
  side.
- `.tmp/real-world-codex-comparison/<timestamp>/summary.md`: per-run summary.
- `.tmp/real-world-codex-comparison/<timestamp>/*.jsonl`: timestamped Codex
  JSONL transcript for the run.
- `.tmp/real-world-codex-comparison/<timestamp>/*.raw.jsonl`: raw Codex JSONL
  transcript before timestamp annotation.
- `.tmp/real-world-codex-comparison/<timestamp>/*.result.txt`: final answer.
- `.tmp/real-world-codex-comparison/<timestamp>/*.prompt.txt`: rendered prompt.

## Interpretation

The prewritten REPL result is the lower bound after the browser procedure has
been factored into reusable code. The interactive REPL result is the important
one for agent work: Codex still discovers, writes, observes, and synthesizes
during the run, but the transcript sees compact checkpoints instead of full
browser state. In the latest strict pass it is both faster and much cheaper
than direct Chrome MCP. The remaining optimization target is not the evaluator;
it is the model time between semantic evaluator steps.
