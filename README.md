# MCP-2-REPL

MCP-2-REPL turns any stdio MCP server into a persistent JavaScript evaluator.
The mental model is procedure abstraction: MCP tools become primitive
procedures, agents define small compound procedures, and each REPL step
evaluates one expression against a persistent environment.

On a no-login Apple US/English shopping research task, the same Codex prompt was
run three ways: direct Chrome MCP, interactive mcp2repl, and a prewritten
mcp2repl procedure.

https://github.com/user-attachments/assets/6f148216-9284-4ef5-9336-c928354098bf

The embedded video is accelerated to 2x playback to keep the README concise.
The elapsed labels over Chrome still show the original run clock. It is the
three-row comparison: Codex process on the left, visible Chrome on the right.
The middle row finishes while the pure MCP row is still issuing browser tool
calls. That is the core difference: mcp2repl lets an agent compose multiple MCP
primitives into one evaluator step.

| Result | Pure Chrome MCP | Interactive REPL | Prewritten REPL |
| --- | ---: | ---: | ---: |
| Elapsed time | 248.9s | 122.4s, 2.03x faster | 47.8s, 5.21x faster |
| Total tokens | 1.29M | 292k, 77.3% less | 98.8k, 92.3% less |
| Top-level actions | 36 MCP calls | 5 evaluator steps | 1 evaluator step |
| External validation | pass | pass | pass |

The video makes the advantage visible: pure MCP scrolls through many
`evaluate_script` turns, interactive REPL moves Chrome in short bursts after
each `mcp2repl eval`, and shorter rows freeze when they finish under the shared
clock. The full prompt, raw JSONL accounting, reproduction steps, and detailed
tables are in [the real-world comparison notes](examples/real-world-codex-comparison/README.md).

MCP exposes tools as remote actions. MCP-2-REPL imports those tools as
primitive procedures into a persistent JavaScript evaluator, so agents can build
compound procedures, keep state in an environment, and evaluate work
incrementally.

```js
async function pageTitle(url) {
  await mcp.call("navigate_page", { url });
  return await api.evalTool("evaluate_script", () => document.title);
}

return await pageTitle("https://example.com");
```

The useful shape is not one huge script. Define small compound procedures,
evaluate one expression, inspect the compact value, then choose the next
expression. Tool loops, extraction, retries, and large intermediate observations
stay inside the evaluator environment.

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
  --eval 'await mcp.call("navigate_page", { url: "https://example.com" }); return await api.evalTool("evaluate_script", () => document.title)'
```

Run a file:

```bash
npx mcp2repl \
  --config ./examples/chrome-devtools.json \
  --server chrome-devtools \
  --file ./examples/chrome-research-task.repl.js
```

For agent sessions, put stable options in environment variables so individual
calls stay short. Then evaluate small, typed steps against the same session:

```bash
export MCP2REPL_CONFIG=./examples/chrome-devtools-visible.json
export MCP2REPL_SERVER=chrome-devtools
export MCP2REPL_SESSION=apple
export MCP2REPL_JSON=1
export MCP2REPL_QUIET=1
export MCP2REPL_TIMEOUT=240
export MCP2REPL_MAX_OUTPUT_CHARS=6000

node ./src/cli.js -e - <<'JS'
globalThis.task = { facts: {}, sources: [] };
return task;
JS

node ./src/cli.js -e - <<'JS'
const docs = await api.library("navigate page evaluate wait", { limit: 4 });
return docs.map((doc) => ({ name: doc.name, call: doc.example }));
JS

node ./src/cli.js -e - <<'JS'
await mcp.call("navigate_page", { url: "https://www.apple.com/macbook-air/" });
task.sources.push("https://www.apple.com/macbook-air/");
task.facts.air = await api.evalTool("evaluate_script", () => ({
  title: document.title,
  prices: [...document.body.innerText.matchAll(/\$[\d,]+/g)].slice(0, 8).map((m) => m[0])
}));
return await api.print({ step: "air-overview", facts: task.facts.air }, { maxChars: 2000 });
JS
```

The first session client call auto-starts a daemon when `--config` or
`MCP2REPL_CONFIG` is present. Session clients wait up to 30 seconds for the
socket by default.

`-e` accepts normal multi-line shell strings, can be repeated to append lines,
and `-e -` reads the program from stdin:

```bash
node ./src/cli.js -e - <<'JS'
task.facts.count = Object.keys(task.facts).length;
return task.facts;
JS
```

This keeps the interface as evaluator expressions over a persistent
environment. If a neutral helper becomes too long for a readable expression,
use `--load` to install the helper once, then keep the actual work as
medium-sized, inspectable `-e` or `--call` steps. Avoid a monolithic procedure
that tries to finish the whole task in one evaluation.

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
- `api.callTool(server, name, args)` calls a tool on a named upstream server.
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
- `api.project(value, projection, options)` builds compact evaluator-side views.
- `api.print(value, { projection, maxChars, fit })` returns a model-facing
  envelope. It auto-fits the representation when possible. If the value is still
  too large, it returns `ResultTooLarge`, `largeFields`, and a repair hint
  instead of encouraging shell-side artifact inspection.
- `api.load(path)` loads a JavaScript file into the same evaluator context and
  returns a manifest with `loaded`, `digest`, `exports`, and `topLevel`.
- `api.saveArtifact(name, value, { format })` writes large intermediate data to
  `.mcp2repl/artifacts/` by default and returns an evaluator-memory handle:
  `{ name, kind, bytes, format, readWith }`.
- `api.readArtifact(handleOrName)` reads a previously saved artifact back into
  the evaluator.

Use `--artifact-dir <path>` or `MCP2REPL_ARTIFACT_DIR` to choose another
artifact directory.

Projection specs are plain JSON-shaped objects. Normal keys select object
fields, `$slice` limits arrays, and `$items` projects each array item:

```js
return await api.print(result, {
  maxChars: 6000,
  projection: {
    invariantPassed: true,
    options: {
      $slice: 3,
      $items: { productName: true, visibleStartingPrice: true, evidence: { $slice: 4, $items: true } }
    }
  }
});
```

`api.print()` never changes the underlying evaluator value. When it needs to
shorten the model-facing representation, the full value remains available as an
evaluator-memory artifact in the returned `printer.artifact` handle.

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
CODEX_MODEL=gpt-5.5 \
CODEX_ATTEMPTS=2 \
CODEX_RETRY_DELAY_MS=30000 \
CODEX_VARIANTS=pure-mcp,interactive-repl,scripted-repl \
REAL_WORLD_CHROME_BROWSER_URL=http://127.0.0.1:9223 \
REAL_WORLD_CHROME_CONFIG=.tmp/recordings/chrome-devtools-browserurl.json \
npm run experiment:real-world
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
