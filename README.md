# MCP-2-REPL

MCP-2-REPL turns any stdio MCP server into a persistent JavaScript evaluator.
On a real Apple shopping research task with visible Chrome, the same Codex
prompt was run three ways:

[![Three-way Codex browser task comparison](docs/assets/real-world-time-token-comparison.jpg)](docs/assets/real-world-time-token-comparison.mp4)

Click the preview to open the recorded comparison video. It shows native Codex
TUI output beside visible Chrome for Pure Chrome MCP, Interactive REPL, and
Prewritten REPL, with elapsed time and token usage overlaid.

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

Pure Chrome MCP is the baseline. The interactive REPL used 16.1% of the
baseline total tokens and finished 21.6% faster, while still passing the same
external validator. The prewritten REPL used 9.7% of the baseline total tokens
and finished 58.4% faster; that is the amortized path once exploration becomes
reusable code.

MCP gives an agent remote-control tools. MCP-2-REPL gives the agent a language
surface over those tools: async JavaScript, persistent globals, local loops,
try/catch, artifact files, and runtime tool discovery.

```js
await tools.new_page({ url: "https://example.com" });

return await api.evalTool("evaluate_script", () => ({
  title: document.title,
  links: [...document.links].map((link) => link.href).slice(0, 10)
}));
```

The useful shape is MCP-like interaction where the model sends compact calls,
while browser logic, extraction, retries, and large intermediate data stay
inside the evaluator.

## Install and Usage

```bash
npx mcp2repl --config ./mcp.json
```

From a local checkout:

```bash
npm install
npm test
```

Requires Node.js 20 or newer.

Run one JavaScript program against an MCP server:

```bash
npx mcp2repl \
  --config ./examples/chrome-devtools.json \
  --server chrome-devtools \
  --eval 'await tools.new_page({ url: "https://example.com" }); return await api.evalTool("evaluate_script", () => document.title)'
```

Run a file:

```bash
npx mcp2repl \
  --config ./examples/chrome-devtools.json \
  --server chrome-devtools \
  --file ./examples/chrome-research-task.repl.js
```

For agent sessions, put stable options in environment variables so individual
calls stay short, then send one multi-line evaluator program:

```bash
export MCP2REPL_CONFIG=./examples/chrome-devtools-visible.json
export MCP2REPL_SERVER=chrome-devtools
export MCP2REPL_SESSION=apple
export MCP2REPL_JSON=1
export MCP2REPL_QUIET=1
export MCP2REPL_TIMEOUT=240
export MCP2REPL_MAX_OUTPUT_CHARS=6000

node ./src/cli.js -e '
await api.load(".tmp/task-harness.js");
const probe = await appleTask.probe({});
return await appleTask.final({ probe });
'
```

The first session client call auto-starts a daemon when `--config` or
`MCP2REPL_CONFIG` is present. Session clients wait up to 30 seconds for the
socket by default.

`-e` accepts normal multi-line shell strings, can be repeated to append lines,
and `-e -` reads the program from stdin:

```bash
printf '%s\n' \
  'await api.load(".tmp/task-harness.js");' \
  'const probe = await appleTask.probe({});' \
  'return await appleTask.final({ probe });' \
  | node ./src/cli.js -e -
```

This keeps the interface as one evaluator entrypoint while still supporting
large multi-line JavaScript. Use `--load` and `--call` when you deliberately
want separate checkpoints; prefer one multi-line `-e` when the steps are known
up front.

Print generated function docs for matching tools without starting an
interactive session:

```bash
npx mcp2repl \
  --config ./examples/chrome-devtools.json \
  --server chrome-devtools \
  --library "navigate evaluate wait page" \
  --limit 6 \
  --json
```

`--library` is MCP-agnostic. It connects to the configured server, reads tool
JSON Schemas, and emits TypeScript-like async function signatures plus stable
example calls. Agent prompts can include only selected docs instead of every MCP
schema.

## Runtime API

Scripts are evaluated inside an async function. Use `return` for the final
value. Main globals:

- `tools.safeName(args)` calls upstream tools through identifier-safe aliases.
- `mcp.call(name, args)` calls an upstream MCP tool by exact name.
- `mcp.tools[name](args)` calls an upstream MCP tool by exact name.
- `mcp.<server>.<tool>(args)` calls namespaced tools when a multi-server config
  is used.
- `sleep(ms)` returns a promise.
- `api.searchTools(query, { limit })` returns short ranked tool summaries.
- `api.library(query, { limit })` returns TypeScript-like function docs
  generated from any MCP JSON Schema.
- `api.guide(query, { limit })` returns compact runtime guidance.
- `api.describeTool(name)` or `api.describeTool(server, tool)` returns one full
  tool definition, schema, and generated call hints.
- `api.listTools({ schemas: false })` returns a compact tool index.
- `api.unwrap(value)` unwraps common MCP content envelopes.
- `api.evalTool(nameOrQuery, fn, args)` adapts generic eval/code/function-style
  MCP tools. For Chrome DevTools MCP it embeds `args` into the function source
  and sends only the schema-valid `function` parameter to `evaluate_script`.
- `api.load(path)` loads a JavaScript file into the same evaluator context.
- `api.saveArtifact(name, value, { format })` writes large intermediate data to
  `.mcp2repl/artifacts/` by default.
- `api.readArtifact(name)` reads a previously saved artifact.

Use `--artifact-dir <path>` or `MCP2REPL_ARTIFACT_DIR` to choose another
artifact directory.

## Agent Skill

This repository includes a static discovery skill at `skills/mcp2repl/SKILL.md`.
Install it into an agent's skills directory so the agent knows when to choose
mcp2repl over raw MCP tool calls:

```bash
mkdir -p ~/.codex/skills
cp -R ./skills/mcp2repl ~/.codex/skills/mcp2repl
```

The skill stays static. Dynamic MCP context stays in the REPL through
`api.searchTools()`, `api.describeTool()`, `api.library()`, and the generated
function surface.

## Experiment

The comparison task asks Codex to help an ordinary person choose a MacBook for
remote work, many browser tabs, video calls, light photo editing, occasional
travel, and several years of use. It must use public Apple pages only. No login,
cart, checkout, personal information, direct HTTP clients, or browserless
scraping are allowed.

The prompt covers five public Apple URLs: MacBook Air, MacBook Pro, Mac
compare, Air buy page, and Pro buy page. It requires three options: 13-inch
MacBook Air, 15-inch MacBook Air, and 14-inch MacBook Pro, each with at least
16GB memory and 512GB storage. The validator checks product separation, price,
chip, memory, storage, evidence, and different 13-inch/15-inch Air prices.

Reproduce:

```bash
CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=pure-mcp npm run experiment:real-world

CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=interactive-repl npm run experiment:real-world

CODEX_MODEL=gpt-5.5 CODEX_ATTEMPTS=2 CODEX_RETRY_DELAY_MS=30000 \
  CODEX_VARIANTS=scripted-repl npm run experiment:real-world
```

Artifacts are written under `.tmp/real-world-codex-comparison/<timestamp>/`.
Each run writes the rendered prompt, isolated Codex home, JSONL transcript,
final result, and `summary.md`. The task prompt is
`examples/real-world-codex-comparison/prompt.txt`; the prewritten REPL arm is
`examples/real-world-codex-comparison/scripted-repl-task.js`. Full experiment
details are in `examples/real-world-codex-comparison/README.md`.

## Other Examples

Run without Chrome using the built-in mock MCP server:

```bash
npm run smoke
```

Run the Chrome demo:

```bash
npm run demo:chrome
```

Run the static Chrome comparison:

```bash
npm run experiment:chrome
```

## Publishing

The package is published as `mcp2repl` on npm. GitHub Actions publishes
automatically when a GitHub Release is published, and can also be triggered
manually from the `Publish to npm` workflow.

Repository setup required once:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
Name: NPM_TOKEN
Value: npm automation token with publish access for mcp2repl
```

## Security

MCP-2-REPL evaluates JavaScript with the permissions of the current Node.js
process and exposes every configured upstream MCP tool to that code. Only run
configs and programs you trust.
