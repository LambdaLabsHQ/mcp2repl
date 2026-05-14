---
name: mcp2repl
description: "Use when an agent needs to discover and use mcp2repl: a CLI-launched persistent JavaScript REPL that turns MCP tools into runtime library calls. Especially relevant for tasks with many MCP tools, browser automation, repeated tool calls, loops, retries, extraction, aggregation, or large intermediate observations."
metadata:
  short-description: Use MCP tools through a JS REPL runtime
---

# MCP-2-REPL

Use `mcp2repl` when raw MCP calls would create a long transcript. In SICP
terms, MCP tools are primitive procedures, your small helper functions define
compound procedures, a session is the evaluator environment, and artifacts are
evaluator memory.

## Staged REPL Path

Do not inspect `src/` for API details. If `MCP2REPL_*` defaults are set, keep
commands short and use the persistent session as the evaluator environment.
Prefer 3-6 right-sized semantic steps over one large program or many tiny
tool-shaped commands. The first step should usually be a minimal bootstrap that
also performs the first real primitive action, so the session becomes observable
quickly instead of spending a full turn on setup. Install compound procedures
incrementally: define only the helpers needed for the current semantic step,
call that step in the same evaluator expression, then keep the procedure
available for repairs or final synthesis. Do not paste previous helper bodies
again. A step may contain a bounded local loop over tightly coupled primitive
calls when it returns one compact checkpoint that guides the next decision. If
the helper code would make repeated heredocs long, either define named
procedures on `globalThis` incrementally or write a small module of named
compound procedures, load it once, then call one procedure per step. For any
multi-line expression, shell-sensitive text (`$`, `!`, backticks), or
regex-heavy code, read the expression from stdin with a quoted heredoc. When
`MCP2REPL_*` defaults are set, stdin is the shortest multi-line form:

1. Discover only the few primitive procedures needed for this task, and project
   discovery results to names, input keys, and call examples before printing.
2. Bootstrap the evaluator with only the smallest state and transport helpers,
   then immediately do the first real primitive action, such as navigating the
   current browser tab or probing one entity. Do not put parsers, validators, or
   domain-specific extraction into this first step.
3. Explore one semantic slice per evaluator expression by defining and calling
   one named procedure: one entity, one UI state cluster, one workflow phase, or
   one missing required fact.
4. Return compact checkpoints with `api.print`; save raw observations as
   artifacts so the model does not carry page text. Do one bounded fallback
   inside the same semantic step before returning a missing required field.
5. Patch or extend only the smallest helper that failed. Once typed facts pass
   validation, project the final answer.

```bash
node ./src/cli.js <<'JS'
const tools = (await api.searchTools("navigate evaluate"))
  .map((tool) => ({ name: tool.name, inputKeys: tool.inputKeys, call: tool.call }))
  .slice(0, 6);
return api.print({ step: "discover", tools }, { maxChars: 2000 });
JS

node ./src/cli.js <<'JS'
globalThis.task = {
  facts: {},
  preview: {},
  sources: [],
  async call(name, args) { return api.unwrap(await mcp.call(name, args)); },
};
const first = await task.call("navigate_page", { url: "https://example.com" });
task.sources.push("https://example.com");
task.preview.first = first;
return api.print({ step: "bootstrap:first-action", preview: task.preview, sources: task.sources }, { maxChars: 1000 });
JS

node ./src/cli.js <<'JS'
task.observeSlice = async function (slice) {
  // Call primitive procedures for one semantic slice and update task.facts.
  return this.checkpoint(`observe:${slice}`);
};
return await task.observeSlice("first");
JS

node ./src/cli.js <<'JS'
task.presentFinal = function () {
  const finalValue = {};
  return api.print(finalValue, { maxChars: 5000, maxString: 120 });
};
return await task.presentFinal();
JS
```

Evaluator rules:

- Keep browser loops, retries, extraction, validation, and aggregation inside the
  evaluator, but keep each visible step small enough that its result can guide
  the next step.
- Do not make a separate shell command for every primitive tool call. The unit
  of interaction is a semantic checkpoint, not the transport call.
- Keep step latency uniform: make the first evaluator command produce a real
  primitive action, avoid a huge final step that performs most of the task,
  avoid tiny shape-check commands unless a prior checkpoint failed, and combine
  module loading with the first procedure call when a module is used.
- After setup, a successful REPL step should either define-and-call one new
  semantic procedure or call/patch an existing procedure. Do not paste the same
  long helper body into every step.
- Put transport boilerplate in setup helpers. For example, a browser task may
  define only `go`/`evalPage` in bootstrap. If repeated page extraction appears
  after the first observation, define one small `pageFacts(url, keepPattern)`
  helper; otherwise keep the observation procedure direct. Avoid installing a
  broad extraction framework before the checkpoint proves it will pay for
  itself.
- The evaluator session preserves top-level lexical declarations. After setup,
  wrap repair/observation snippets in `{ ... }` or use unique variable names, and
  explicitly `return api.print(...)` or `return checkpoint(...)`.
- A loaded module is an abstraction layer, not the interaction. It should expose
  slice procedures such as `setup`, `observeEntity`, `validate`, and
  `presentFinal`; it should not auto-run the whole task.
- Load procedure modules with `--load <file>` or `api.load(path)`. Do not use
  dynamic `import()` inside evaluator snippets to install task procedures.
- Return model-facing values with `api.print(value, { projection, maxChars })`.
- Save raw page text/snapshots with `api.saveArtifact()`; synthesize final
  fields from typed facts, not raw snippets.
- When comparing multiple entities, keep typed facts keyed by entity and
  source; do not fill final fields from a global first match or shared blob.
- Final fields should be short typed facts. If extraction finds legal, footer,
  payment, navigation, footnote, testing, or control text, return `unknown`
  instead of copying it.
- Validate final-field noise and length inside the evaluator before returning.
- Checkpoints should expose compact typed facts and validation failures, not only
  pass/fail, so the next evaluator expression is a real decision.
- When the final checkpoint has no missing required fields, return the final
  value from that same evaluator expression. Do not add a separate shell command
  just to re-print or export the value.
- Artifacts are evaluator memory. Read them inside task procedures with
  `api.readArtifact()`, not from shell.
- Patch only after a concrete evaluator error or failed validation. Once
  validation passes, return the printed value; do not polish optional fields.

Useful calls:

```js
await api.callTool("chrome-devtools", "navigate_page", { url: "https://example.com" });
const rawResult = await api.evalTool("evaluate_script", (args) => ({ title: document.title, args }), { ok: true });
await api.saveArtifact("evidence.json", rawResult);
return await api.print(rawResult, { projection: { ok: true, count: true }, maxChars: 6000 });
```

`api.evalTool()` embeds `args` into page JavaScript and sends only schema-valid
MCP arguments. Functions passed to `api.evalTool()` are stringified for the
target tool, so they must be self-contained and must not close over evaluator
variables. Do not wrap a helper parameter as `(args) => fn(args)`; pass `fn`
directly. `-e` accepts multi-line strings and `-e -` reads from stdin. When
shell transport makes `$` awkward, build it in JavaScript with
`String.fromCharCode(36)` instead of putting a literal `$` in the snippet.
Prefer tiny scanners over dollar regexes for price-like text: split on the
dollar character, collect leading digits and commas from each segment, reject
segments whose nearby text includes `/mo`, and parse by removing the dollar
character and commas. Avoid shell-sensitive negation in dense expressions; use
positive comparisons such as `includes("/mo") === false` when practical.

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

Load a reusable task module safely, optionally calling its first procedure in
the same evaluator request:

```bash
mcp2repl --quiet --json --max-output-chars 6000 --timeout 180 --config ./mcp.json --server chrome-devtools --session work --load ./task-module.js
mcp2repl --quiet --json --max-output-chars 6000 --timeout 180 --config ./mcp.json --server chrome-devtools --session work --load ./task-module.js --call browserTask.setup
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
node ./src/cli.js --session work --json --max-output-chars 6000 --timeout 180 -e - <<'JS'
globalThis.task = { facts: {}, sources: [] };
return { ready: true };
JS
node ./src/cli.js --session work --json --max-output-chars 6000 --timeout 180 -e - <<'JS'
await api.callTool("chrome-devtools", "navigate_page", { url: "https://example.com" });
task.facts.title = await api.evalTool("evaluate_script", () => document.title);
return await api.print({ step: "home", title: task.facts.title }, { maxChars: 1000 });
JS
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
- `api.callTool(server, name, args)` calls a tool on a named upstream server.
- `mcp.call(name, args)` calls an exact upstream MCP tool name.
- `api.searchTools(query, { limit })` returns short ranked tool summaries.
- `api.describeTool(name)` returns one full tool schema plus call hints on demand.
- `api.guide(query, { limit })` returns compact recipes, call forms, and common pitfalls.
- `api.library(query, { limit })` returns TypeScript-like function docs generated from MCP JSON Schemas.
- `api.evalTool(nameOrQuery, fn, args)` calls MCP tools whose schema accepts JavaScript/code/function text. It embeds `args` into the function source and sends only schema-valid tool arguments.
- `api.listTools({ schemas: false })` returns a compact tool index.
- `api.unwrap(value)` normalizes common MCP/Codex/result envelopes and parses JSON strings when possible.
- `api.project(value, projection, options)` builds compact evaluator-side views.
- `api.print(value, { projection, maxChars, fit })` returns a model-facing envelope. It auto-fits the representation when possible; if the value is still too large, it returns `ResultTooLarge`, `largeFields`, and a repair hint.
- `api.load(path)` loads a JavaScript file into the same evaluator context and returns `{ loaded, digest, exports, topLevel }`.
- `api.runtimeDocs()` returns the runtime contract. Discovery helpers are synchronous plain values; tool calls and `api.saveArtifact()` are async.
- `api.saveArtifact(name, value)` writes large intermediate data and returns an evaluator-memory handle `{ name, kind, bytes, format, readWith }`.
- `api.readArtifact(handleOrName)` reads a saved artifact back into the evaluator.
- `sleep(ms)` is available for local waits.

Keep the model-facing output compact. Filter large browser snapshots or API
responses inside JavaScript, then return only compact values or save artifacts.
For exploratory observations, return only a small summary. Do not print full
page text, full snapshots, or large arrays of labels/snippets into the model
transcript.
For browser research, use procedural abstraction rather than one large guessed
script. Start with one semantic slice, inspect the compact value, then choose
the next evaluator expression from that observation.
For multi-step browser research, prefer `--session` so the selected page, open
tabs, variables, and MCP server stay alive across evals.
Do not put long tool-use JavaScript in shell `--eval` strings. Define thin
helpers directly in the session when they fit a readable heredoc. If a
helper or slice procedure becomes too long, put only the compound procedure
layer in a temporary `.js` module, load it once, then keep the actual work as
short evaluator expressions such as `await task.observe(slice)`,
`await task.compose()`, and `await task.validate(value)`. Do not hide the whole
task behind a `run()` or `probe()` procedure that visits every page before the
model sees a checkpoint. Patch only for a concrete syntax, runtime, or
validation failure surfaced by a compact evaluator checkpoint.
For token-sensitive work, the agent should see compact observations,
validation results, or the final value, not every intermediate browser action.
Avoid monolithic procedures that try to complete a whole ambiguous task in one
eval; they are harder to inspect and expensive to repair. Also avoid command
fragments that only wrap a single primitive call when the next primitive call is
already determined by the same semantic slice.
Intermediate evaluator results should be small and decision-oriented. Use
`api.print()` or `api.project()` for model-facing checkpoints. Save raw
observations and large evidence with `api.saveArtifact()`. Return the full
answer only once validation passes.
Every evaluator expression that returns data for the model should end in
`api.print(...)` unless it is already a tiny scalar or status object. The final
answer should use `api.print(finalValue, { projection: ..., maxChars: ... })`
on the first attempt, not after a `ResultTooLarge` repair.
Separate observation procedures from presentation procedures. Observation
procedures may save raw snippets and page text as artifacts; final/presentation
procedures should synthesize short factual fields from that evidence instead of
passing raw snippets through.
Projection specs are plain JSON-shaped objects: normal keys select object
fields, `$slice` limits arrays, and `$items` projects each array item. If
`api.print()` returns `ResultTooLarge`, repair the producing procedure or pass a
narrower projection; do not inspect the artifact from shell.
Artifacts are evaluator-environment values, not a shell-side compression
channel. If a result is too large or malformed, repair the compound procedure
that produced it and rerun that procedure. Use evaluator errors and stacks as
diagnostics for focused repairs, then continue in the evaluator.
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

1. Initialize small session state on `globalThis`, such as `{ facts, preview, sources }`.
2. Start with one small discovery call such as `api.library("navigate evaluate", { limit: 3 })`.
3. Use `api.describeTool()` only for the specific primitive procedures you need.
4. Define thin helper procedures only when repeated calls appear; load a temporary procedure module when repeated heredocs become slow or unreadable.
5. Evaluate one semantic slice per step, such as one entity, UI state cluster,
   workflow phase, or missing required fact.
6. Save large intermediate state with `api.saveArtifact()` and return compact checkpoints with `api.print()`.
7. Repair only the smallest failed helper or extraction step.
8. Return compact JSON or a concise final answer once validation passes.
