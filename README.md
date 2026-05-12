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

## Install / Run

```bash
npx mcp2repl --config ./mcp.json
```

From a local checkout:

```bash
npm install
npm run smoke
```

## CLI eval

```bash
npx mcp2repl --config ./examples/chrome-devtools.json --server chrome-devtools \
  --eval 'await mcp.call("new_page", { url: "https://example.com" }); await tools.evaluate_script({ function: "() => document.title" })'
```

When the config contains multiple `mcpServers`, MCP-2-REPL connects to all
enabled servers by default and exposes namespaced functions:

```js
await mcp.chrome_devtools.new_page({ url: "https://example.com" });
await api.callTool("chrome-devtools", "evaluate_script", { function: "() => document.title" });
```

Use `--server <name>` to connect only one configured server.

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
npx -p mcp2repl mcp2repl-server --config ./examples/chrome-devtools.json --server chrome-devtools
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
- `mcp.<server>.<tool>(args)` calls tools through server namespaces when a
  Claude Desktop-style `mcpServers` config is used.
- `tools.safeName(args)` calls tools through identifier-safe aliases, for example `evaluate_script`.
- `api.callTool(server, tool, args)` calls a namespaced MCP tool by exact server
  and upstream tool names.
- `mcp.listTools()` returns upstream tool metadata.
- `api.describeTool(server, tool)` returns one upstream tool's metadata.
- `sleep(ms)` returns a promise that resolves after `ms`.
- `inspect(value)` formats complex values.

## Security

MCP-2-REPL evaluates JavaScript with the permissions of the current Node.js
process and exposes every configured upstream MCP tool to that code. Only run
configs and programs you trust.

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

## Why This Beats Raw MCP

MCP is a transport and capability registry. It is not a control-flow language.

REPL makes the language the tool layer:

- One tool call can perform conditional waits, loops, retries, and batching.
- Exploratory snippets can become reusable automation scripts.
- Helpers and state can persist for the lifetime of the evaluator process.
- MCP tools remain useful, but they become library calls instead of the agent's primary interface.
