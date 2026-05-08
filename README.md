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
