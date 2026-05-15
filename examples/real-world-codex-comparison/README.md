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
procedure-abstraction prompt was tightened to avoid setup-only pauses, failed
repair churn, and extra final export commands.

Run artifacts:

- Pure Chrome MCP: `.tmp/real-world-codex-comparison/2026-05-15T04-54-40-184Z`
- Interactive REPL: `.tmp/real-world-codex-comparison/2026-05-15T04-48-32-699Z`
- Prewritten REPL: `.tmp/real-world-codex-comparison/2026-05-15T04-59-07-698Z`

| Metric | Pure Chrome MCP | Interactive REPL | Prewritten REPL |
| --- | ---: | ---: | ---: |
| Process abstraction | direct tool calls | small evaluator steps | reusable compound procedure |
| External validation | pass | pass | pass |
| Failed transcript items | 0 | 0 | 0 |
| Input tokens | 1,281,944 | 287,477 | 97,655 |
| Cached input tokens | 1,208,576 | 267,520 | 84,480 |
| Uncached input tokens | 73,368 | 19,957 | 13,175 |
| Output tokens | 7,484 | 4,885 | 1,164 |
| Reasoning output tokens | 1,346 | 417 | 33 |
| Total tokens | 1,289,428 | 292,362 | 98,819 |
| Total tokens vs Pure Chrome MCP | 1.00x | 0.227x | 0.077x |
| Token advantage | baseline | 4.41x fewer | 13.05x fewer |
| Total token reduction | baseline | 77.3% less | 92.3% less |
| Uncached input + output | 80,852 | 24,842 | 14,339 |
| Uncached token advantage | baseline | 3.25x fewer | 5.64x fewer |
| Uncached reduction | baseline | 69.3% less | 82.3% less |
| Strict JSONL elapsed | 248.9s | 122.4s | 47.8s |
| Time vs Pure Chrome MCP | 1.00x | 0.49x | 0.19x |
| Time advantage | baseline | 2.03x faster | 5.21x faster |
| Top-level operations | 36 MCP tool calls | 5 evaluator commands | 1 evaluator command |
| Item types | `{"agent_message":5,"mcp_tool_call":36}` | `{"command_execution":5,"agent_message":1}` | `{"command_execution":1,"agent_message":1}` |
| Codex MCP injected | yes | no | no |
| mcp2repl skill installed | no | yes | yes |

## Step Timing

The strict JSONL recorder timestamps every action event when it is received.
This makes total time and per-step distribution comparable across variants.

| Metric | Pure Chrome MCP | Interactive REPL | Prewritten REPL |
| --- | ---: | ---: | ---: |
| Action steps | 36 | 5 | 1 |
| First action | 11.0s | 20.0s | 14.6s |
| Median action | 0.9s | 2.6s | 12.8s |
| P90 action | 5.1s | 3.0s | 12.8s |
| Max action duration | 5.1s | 3.0s | 12.8s |
| Max gap between actions | 7.6s | 22.3s | 0.0s |
| Slowest actions | `evaluate_script:5.1s, evaluate_script:5.1s, evaluate_script:5.1s` | `mcp2repl eval:3.0s, mcp2repl eval:2.7s, mcp2repl eval:2.6s` | `mcp2repl stdin eval:12.8s` |

The interactive REPL result is faster both in total and at the evaluator action
layer: it has no failed commands, no source-inspection detour, and no separate
final export command. All five evaluator actions complete within 3.0s. Its
remaining non-uniformity is the 22.3s model-composition gap between evaluator
steps. That gap is not browser work; it is Codex writing the next compound
procedure.

## Three-Row Process Video

[![Three-way Codex browser task comparison](../../docs/assets/real-world-time-token-comparison.jpg)](../../docs/assets/real-world-time-token-comparison.mp4)

The committed video is a 2x playback copy of the original comparison layout:
three rows, each with Codex TUI on the left and visible Chrome recording on the
right. The rows are Pure Chrome MCP, Interactive REPL, and Prewritten REPL. Use
the strict JSONL tables above for benchmark claims; use the video to inspect
the actual process shape and browser motion.

How to read the video:

- The rows are independent real runs, not replayed from one browser trace. The
  recorder resets Chrome to Apple before each row, but Apple page carousel,
  scroll, and configurator state can differ. Compare process shape and pacing,
  not exact pixels.
- Pure Chrome MCP is a direct-action process. The terminal shows many
  `chrome-devtools/evaluate_script` calls because every browser primitive is a
  top-level Codex action. Some calls do not visibly move Chrome because they
  read DOM state, but they still cost a full agent action.
- Interactive REPL is a procedure-abstraction process. The terminal shows a
  small number of `mcp2repl eval` commands. Each command defines or calls a
  compound procedure, and Chrome then performs a cluster of page actions inside
  the evaluator before returning a compact checkpoint.
- Prewritten REPL is the factored endpoint. It runs one reusable compound
  procedure, so Chrome moves in one continuous burst and the terminal has one
  evaluator command.
- The final stitched video freezes shorter rows after they finish. In the
  source recording, scripted finishes around 0:46, interactive around 2:03,
  and pure MCP around 4:09. The committed README copy plays at 2x speed, but
  the on-screen elapsed labels still show that original run clock. The freeze
  is intentional: it keeps one shared clock so the viewer can see that pure MCP
  is still working after the REPL rows are done.

The most important visual difference is therefore not which Apple subpage is on
screen at a particular second. It is that pure MCP spends the whole recording in
small remote tool turns, while interactive REPL compresses browser work into a
few evaluator turns and keeps the intermediate browser state out of the model
transcript.

What the advantage looks like in the video:

| Visible cue | What to look for | What it demonstrates |
| --- | --- | --- |
| Earlier freeze | The scripted row freezes first, then the interactive row freezes around 2:03, while pure MCP continues until about 4:09. | REPL finishes the same validated task sooner under the shared video clock. |
| Fewer terminal turns | Pure MCP keeps printing many `chrome-devtools/evaluate_script` started/completed lines; interactive REPL shows only a handful of `mcp2repl eval` commands. | Procedure abstraction reduces top-level agent actions from 36 MCP calls to 5 evaluator commands. |
| Clustered Chrome motion | In the interactive row, one evaluator command can navigate, extract, normalize, and checkpoint a product slice before returning. | Browser primitives are composed inside the evaluator instead of crossing the model/tool boundary one by one. |
| Less transcript churn | The pure MCP terminal repeatedly alternates observation and decision; the interactive terminal mostly shows compact checkpoints and the final JSON. | Large intermediate observations stay in evaluator memory, which is why the JSONL token count is lower. |
| Similar end state | All rows end on Apple MacBook research pages and pass the external validator. | The speed and token gains do not come from skipping the task or using a different website. |

The video therefore supports the numeric table in a concrete way: the stopwatch
shows elapsed-time advantage, the terminal scroll shows action-count advantage,
and the right-side Chrome clusters show the evaluator doing compound work
between model turns.

Final video artifacts:

- `docs/assets/real-world-time-token-comparison.mp4`: committed README video,
  accelerated to 2x playback.
- `docs/assets/real-world-time-token-comparison.jpg`: committed preview frame.
- `.tmp/recordings/20260515T050200Z-three-way-comparison/final-time-token-comparison.web.mp4`: local full-speed stitched source used for docs.

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
- `https://www.apple.com/us/shop/buy-mac/macbook-pro/14-inch`

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
RECORD_STRICT_JSON=1 CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=1 \
  npm run record:real-world:composite -- pure-mcp
RECORD_STRICT_JSON=1 CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=1 \
  npm run record:real-world:composite -- interactive-repl
RECORD_STRICT_JSON=1 CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=1 \
  npm run record:real-world:composite -- scripted-repl
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

Stitch the three composite videos into the committed three-row layout:

```bash
npm run record:real-world:stitch -- \
  --pure .tmp/recordings/20260515T045436Z-pure-mcp-composite/composite.mp4 \
  --interactive .tmp/recordings/20260515T044829Z-interactive-repl-composite/composite.mp4 \
  --scripted .tmp/recordings/20260515T045904Z-scripted-repl-composite/composite.mp4 \
  --out .tmp/recordings/20260515T050200Z-three-way-comparison/final-time-token-comparison.web.mp4 \
  --poster .tmp/recordings/20260515T050200Z-three-way-comparison/final-time-token-comparison.jpg \
  --poster-time 120
```

Create the shorter README copy from that full-speed source:

```bash
ffmpeg -hide_banner -y \
  -i .tmp/recordings/20260515T050200Z-three-way-comparison/final-time-token-comparison.web.mp4 \
  -filter:v "setpts=0.5*PTS" \
  -r 24 -an -c:v libx264 -crf 28 -preset medium -pix_fmt yuv420p \
  -movflags +faststart \
  docs/assets/real-world-time-token-comparison.mp4

ffmpeg -hide_banner -y \
  -ss 60 \
  -i docs/assets/real-world-time-token-comparison.mp4 \
  -frames:v 1 -q:v 3 \
  docs/assets/real-world-time-token-comparison.jpg
```

## Useful Files

- `run.mjs`: experiment runner, Codex isolation, variant setup, usage parsing,
  validation, and summary generation.
- `prompt.txt`: shared task prompt with variant-specific capability
  instructions inserted at runtime.
- `scripted-repl-task.js`: prewritten REPL program used by the scripted arm.
- `record-composite.mjs`: records native Codex TUI and visible Chrome side by
  side.
- `stitch-comparison-video.mjs`: stacks the three side-by-side recordings into
  one comparison video and freezes shorter rows to the baseline duration.
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
