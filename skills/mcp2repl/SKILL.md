---
name: mcp2repl
description: "Use when an agent needs to discover and use mcp2repl: a CLI-launched persistent JavaScript REPL that turns MCP tools into runtime library calls. Especially relevant for tasks with many MCP tools, browser automation, repeated tool calls, loops, retries, extraction, aggregation, or large intermediate observations."
metadata:
  short-description: Use MCP tools through a JS REPL runtime
---

# MCP-2-REPL

Use `mcp2repl` when raw MCP tool calls would create a long transcript: repeated
browser actions, polling, retries, multi-page extraction, batching, or local data
processing.

The CLI starts the runtime. Think in SICP terms: MCP tools become primitive
procedures; task-specific JavaScript defines compound procedures; a session is a
persistent evaluator environment; artifacts are named observations kept out of
the model transcript.

## Fast Path

For token-sensitive browser work in this repository, use this shape and do not
inspect `src/` for API details. If `MCP2REPL_*` environment defaults are set,
commands stay short. Load a task module once, then evaluate medium-sized
compound procedures:

```bash
node ./src/cli.js -e 'await api.load(".tmp/task-module.js"); return await task.setup();'
node ./src/cli.js -e 'return await task.observe({ page: "home" });'
node ./src/cli.js -e 'return await task.composeAndValidate();'
```

`-e` accepts normal multi-line shell strings, can be repeated to append lines,
and `-e -` reads the program from stdin.

```bash
printf '%s\n' \
  'await api.load(".tmp/task-module.js");' \
  'await task.setup();' \
  'return await task.observe({ page: "home" });' \
  | node ./src/cli.js -e -
```

Inside the loaded task module:

```js
await tools.navigate_page({ url: "https://example.com" });
await mcp.chrome_devtools.navigate_page({ url: "https://example.com" });
await api.callTool("chrome-devtools", "navigate_page", { url: "https://example.com" });
await api.evalTool("evaluate_script", (args) => ({ title: document.title, args }), { ok: true });
await api.load(".tmp/task-module.js");
await api.saveArtifact("evidence.json", compactValue);
```

Use `api.evalTool()` for page JavaScript. It embeds `args` into the function
source and sends only schema-valid MCP arguments.

## When To Use

Prefer `mcp2repl` when:

- Many MCP tools are available and loading every schema into prompt context is expensive.
- A task needs loops, retries, waits, branching, or aggregation.
- Large observations should be filtered in code before returning to the model.
- A successful exploration should become a reusable script.

Do not use it for one-off actions where a direct shell command or one MCP call is simpler.

## Basic Use

Run JavaScript against one configured MCP server:

```bash
mcp2repl --quiet --json --max-output-chars 6000 --timeout 180 --config ./mcp.json --server chrome-devtools --eval 'return api.runtimeDocs()'
```

Run a script file:

```bash
mcp2repl --quiet --json --max-output-chars 6000 --timeout 180 --config ./mcp.json --server chrome-devtools --file ./task.js
```

Load a reusable task module safely:

```bash
mcp2repl --quiet --json --max-output-chars 6000 --timeout 180 --config ./mcp.json --server chrome-devtools --session work --load ./task-module.js
mcp2repl --session work --json --max-output-chars 6000 --timeout 180 --call browserTask.observe --call-args '{"page":"home"}'
```

`--load` wraps the file in an async function before evaluating it. Use it for
task modules that define `globalThis.someTask = { ... }`; it can be rerun
after a patch without top-level `const`/`let` redeclaration conflicts.

Use `node ./src/cli.js` instead of `mcp2repl` inside a local checkout:

```bash
node ./src/cli.js --quiet --json --max-output-chars 6000 --timeout 180 --config ./examples/chrome-devtools.json --server chrome-devtools --file ./examples/chrome-research-task.repl.js
```

Use visible Chrome when the user wants to observe browser actions:

```bash
node ./src/cli.js --quiet --json --max-output-chars 6000 --timeout 180 --config ./examples/chrome-devtools-visible.json --server chrome-devtools --file ./task.js
```

When a visible Chrome tab is already open for recording or user observation,
reuse that tab. Prefer `navigate_page` on the current tab and avoid `new_page`
unless the task explicitly requires a separate tab.

For multi-step work, keep one MCP connection alive with a session:

```bash
node ./src/cli.js --quiet --timeout 180 --config ./mcp.json --server chrome-devtools --session work --json --max-output-chars 6000 --eval 'return api.searchTools("navigate evaluate", { limit: 3 })'
node ./src/cli.js --session work --json --max-output-chars 6000 --timeout 180 -e '
await api.load("./task-module.js");
await browserTask.setup();
return await browserTask.observe({ page: "home" });
'
node ./src/cli.js --session work --stop
```

The first session client call auto-starts the session daemon when `--config`,
`--command`, or `--mock` is present. Session clients wait up to 30 seconds for
the socket by default, which helps when the MCP server is slow to start.

## Runtime Contract

Inside the REPL:

```js
await tools.safeName({ ...args });
await mcp.call("exact.tool.name", { ...args });
api.searchTools("click button");
api.describeTool("chrome-devtools.click");
api.guide("browser automation");
api.library("browser automation");
await api.evalTool("evaluate_script", (args) => ({ title: document.title, args }), { ok: true });
await api.saveArtifact("snapshot.json", largeValue);
await api.readArtifact("snapshot.json");
```

Core globals:

- `tools.safeName(args)` calls identifier-safe MCP tool aliases.
- `mcp.call(name, args)` calls an exact upstream MCP tool name.
- `api.searchTools(query, { limit })` returns short ranked tool summaries.
- `api.describeTool(name)` returns one full tool schema plus call hints on demand.
- `api.guide(query, { limit })` returns compact recipes, call forms, and common pitfalls.
- `api.library(query, { limit })` returns TypeScript-like function docs generated from MCP JSON Schemas.
- `api.evalTool(nameOrQuery, fn, args)` calls MCP tools whose schema accepts JavaScript/code/function text. It embeds `args` into the function source and sends only schema-valid tool arguments.
- `api.listTools({ schemas: false })` returns a compact tool index.
- `api.unwrap(value)` normalizes common MCP/Codex/result envelopes and parses JSON strings when possible.
- `api.load(path)` loads a JavaScript file into the same evaluator context.
- `api.runtimeDocs()` returns the runtime contract. Discovery helpers are synchronous plain values; tool calls and `api.saveArtifact()` are async.
- `api.saveArtifact(name, value)` writes large intermediate data to a file.
- `api.readArtifact(name)` reads a saved artifact back into the evaluator.
- `sleep(ms)` is available for local waits.

Keep the model-facing output compact. Filter large browser snapshots or API
responses inside JavaScript, then return only compact values or save artifacts.
For exploratory observations, return only a small summary. Do not print full
page text, full snapshots, or large arrays of labels/snippets into the model
transcript.
For browser research, use procedural abstraction rather than one large guessed
script. Start with one page or one UI state, inspect the compact value, then
choose the next evaluator expression from that observation.
For multi-step browser research, prefer `--session` so the selected page, open
tabs, variables, and MCP server stay alive across evals.
Do not put long tool-use JavaScript in shell `--eval` strings. Write compound
procedures to a temporary `.js` task module, then use short evaluator
expressions such as `await api.load(path)`, `await task.observe(slice)`,
`await task.compose()`, and `await task.validate(value)`.
For token-sensitive work, the agent should see compact observations,
validation results, or the final value, not every intermediate browser action.
Avoid monolithic procedures that try to complete a whole ambiguous task in one
eval; they are harder to inspect and expensive to repair.
For browser page evaluation or any eval-like MCP tool, prefer `api.evalTool()`
over hand-written transport wrappers. Do not add unsupported `args` keys to MCP
tool calls; `api.evalTool()` embeds arguments according to the tool schema.

## MCP Config Registration

`mcp2repl` reads Claude Desktop-style MCP config files:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

Register a new MCP server by adding it to the config under `mcpServers`, then
select it with `--server <name>`. Omit `--server` to connect all enabled servers
and use namespaced functions like `mcp.chrome_devtools.new_page(...)`.

## Skill Registration

To make agents discover this workflow, install this skill folder into the
agent's skills directory, for example:

```bash
mkdir -p ~/.codex/skills
cp -R ./skills/mcp2repl ~/.codex/skills/mcp2repl
```

For repository-local agents, keep this folder at:

```text
skills/mcp2repl/SKILL.md
```

The skill is intentionally static. Do not paste full MCP tool schemas into this
file. Dynamic MCP context belongs in the REPL via `api.searchTools()` and
`api.describeTool()`.

## Recommended Pattern

1. Write a small task module under `.tmp/` that exports compound procedures on `globalThis`.
2. Start with one small discovery call such as `api.library("navigate evaluate", { limit: 3 })`.
3. Use `api.describeTool()` only for the specific primitive procedures you need.
4. Put tight loops, waits, retries, extraction, and ranking inside JavaScript procedures.
5. Evaluate medium-sized steps: setup, observe one slice, compose, validate, repair only missing fields.
6. Save large intermediate state with `api.saveArtifact()`.
7. Return compact JSON or a concise final answer.
