# MCP-2-REPL

MCP-2-REPL turns an arbitrary stdio MCP server into a persistent JavaScript evaluator.
Instead of exposing dozens of hand-authored tools to the agent, it exposes one universal tool:

```text
eval(code)
```

Inside that evaluator, upstream MCP tools are available as ordinary async JavaScript functions:

```js
await mcp.call("navigate_page", { url: "https://example.com" });
await tools.evaluate_script({ function: "() => document.title" });
```

That means control flow moves from the agent/tool-call loop into the language:

```js
for (let i = 0; i < 20; i += 1) {
  const title = await tools.evaluate_script({ function: "() => document.title" });
  if (title.includes("Example")) break;
  await sleep(250);
}
```

Async multi-statement scripts are evaluated inside an async function. Use `return`
when you want a final value:

```js
const title = await tools.evaluate_script({ function: "() => document.title" });
return { title };
```

## Install

```bash
cd tools/mcp2repl
npm install
```

## CLI eval

```bash
node ./src/cli.js --config ./examples/chrome-devtools.json --server chrome-devtools \
  --eval 'await mcp.call("new_page", { url: "https://example.com" }); await tools.evaluate_script({ function: "() => document.title" })'
```

Run the Chrome demo:

```bash
npm run demo:chrome
```

The Chrome demo requires Chrome to be launchable from the environment where the MCP
server runs. In WSL or remote Linux environments, either install Chrome, pass
`--executablePath` in `examples/chrome-devtools.json`, or connect to an existing
debuggable browser with `--browserUrl http://127.0.0.1:9222`.

Run without Chrome using the built-in mock MCP server:

```bash
npm run smoke
```

## Experiment: Native Chrome MCP vs REPL

The core claim of MCP-2-REPL is not that it gives access to more browser
capabilities than `chrome-devtools-mcp`. The upstream MCP server is still doing
the real browser work. The claim is that the agent-facing interface changes from
a remote-control transcript into a programmable runtime.

To make that concrete, this repository includes a small comparison experiment.
Both variants perform the same browser research task with Chrome DevTools MCP:

1. Open `https://example.com`.
2. Wait until the expected DOM state is reached.
3. Extract title, heading, links, and navigation timing.
4. Inspect console messages and network requests.
5. Return one structured report.

The native MCP version is modeled as the top-level calls an agent has to drive
when it talks to `chrome-devtools-mcp` directly:

```text
examples/chrome-research-task.native.json
```

The REPL version is the same task expressed as one JavaScript program submitted
through `eval`:

```text
examples/chrome-research-task.repl.js
```

Run the comparison:

```bash
npm run experiment:chrome
```

Current result:

| Metric | Native chrome-devtools-mcp | MCP-2-REPL |
| --- | ---: | ---: |
| Top-level agent tool calls | 8 | 1 |
| Agent decision points | 8 | 1 |
| Agent-facing payload bytes | 1,604 | 1,413 |
| Where polling lives | agent loop | JavaScript loop |
| Where errors are handled | agent prompt state | throw/catch in code |
| Reusable artifact | transcript | script |

The byte count is intentionally not the main result. For small tasks, the REPL
program can even be similar in size to the native transcript because it carries
the full reusable logic. The important difference is where control flow lives.

With native `chrome-devtools-mcp`, the agent has to decide after every tool
result what to do next: poll again, branch, retry, extract, inspect logs, inspect
network, and merge the final answer. The model's context becomes the control
plane.

With MCP-2-REPL, the model sends a program. Loops, waits, retries, assertions,
intermediate variables, helper functions, and final report shaping live in
JavaScript. The agent still uses Chrome DevTools MCP, but it uses it as a
library inside a runtime instead of as the outer interaction protocol.

That distinction gets stronger as tasks grow:

- A wait loop stays one `for` loop instead of many repeated tool calls.
- A retry policy becomes `try/catch` instead of prompt-level bookkeeping.
- A data extraction pipeline becomes ordinary JavaScript objects and arrays.
- A successful exploration can be committed as a script and rerun.
- Helper functions can persist for the evaluator lifetime.

In other words, native MCP exposes browser operations. MCP-2-REPL exposes a
browser-programming environment.

### Running the Live REPL Variant

If Chrome is available in the environment, the REPL variant can be executed
against the real `chrome-devtools-mcp` server:

```bash
node ./src/cli.js \
  --config ./examples/chrome-devtools.json \
  --server chrome-devtools \
  --file ./examples/chrome-research-task.repl.js
```

The live run still calls `new_page`, `evaluate_script`,
`list_console_messages`, and `list_network_requests` upstream. The difference is
that those calls are no longer separate agent turns.

## Single-tool MCP server

Expose any MCP server back to an agent framework as a single `eval` tool:

```bash
node ./src/server.js --config ./examples/chrome-devtools.json --server chrome-devtools
```

The downstream agent sees one tool:

```text
eval({ code: "..." })
```

The upstream server can still have 30 tools; the agent writes JavaScript once and uses loops,
conditions, helper functions, retries, and batching in-process.

## Injected globals

- `mcp.call(name, args)` calls any upstream MCP tool by exact name.
- `mcp.tools[name](args)` calls any upstream MCP tool by exact name.
- `tools.safeName(args)` calls tools through identifier-safe aliases, for example `evaluate_script`.
- `mcp.listTools()` returns upstream tool metadata.
- `sleep(ms)` returns a promise that resolves after `ms`.
- `inspect(value)` formats complex values.

## Why This Beats Raw MCP

MCP is a transport and capability registry. It is not a control-flow language.

REPL makes the language the tool layer:

- One tool call can perform conditional waits, loops, retries, and batching.
- Exploratory snippets can become reusable automation scripts.
- Helpers and state can persist for the lifetime of the evaluator process.
- MCP tools remain useful, but they become library calls instead of the agent's primary interface.
