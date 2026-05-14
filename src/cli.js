#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { safeIdentifier } from "./mcp-client.js";
import { loadConfig, parseArgs } from "./config.js";
import { connectStdioMcp, connectStdioMcps, createMockClient } from "./mcp-client.js";
import { formatResult, McpRepl, repairErrorEnvelope } from "./evaluator.js";

function wrapConnectedClient(connected, serverName) {
  return {
    async listTools(...args) {
      const listed = await connected.client.listTools(...args);
      if (!serverName) return listed;
      return {
        ...listed,
        tools: (listed.tools ?? []).map((tool) => ({
          ...tool,
          _mcp2repl: {
            server: serverName,
            name: tool.name
          }
        }))
      };
    },
    callTool: (...args) => connected.client.callTool(...args),
    close: connected.close
  };
}

async function createClient(args) {
  if (args.mock) return createMockClient();

  if (args.config) {
    const loaded = await loadConfig(args.config, args.server);
    const connected = loaded.spec
      ? await connectStdioMcp(loaded.spec)
      : await connectStdioMcps(loaded.specs);
    return wrapConnectedClient(connected, loaded.name);
  }

  if (args.command) {
    const connected = await connectStdioMcp({
      command: args.command,
      args: args.args ?? []
    });
    return wrapConnectedClient(connected);
  }

  throw new Error("Provide --mock, --config <path>, or --command <cmd>");
}

function printHelp() {
  output.write(`mcp2repl

Usage:
  mcp2repl --config ./mcp.json
  mcp2repl --config ./mcp.json --server chrome-devtools
  mcp2repl --config ./mcp.json -e 'await mcp.chrome_devtools.new_page({ url: "https://example.com" })'

Options:
  --mock                 Use the built-in mock MCP client.
  --config <path>        Claude Desktop-style MCP config.
  --server <name>        Connect only one configured MCP server.
  --command <cmd>        Connect one stdio MCP command directly.
  --arg <value>          Add one command argument. Can be repeated.
  -e, --eval <code>      Evaluate JavaScript once and exit. Repeat to append lines; use - to read stdin.
  -f, --file <path>      Evaluate a JavaScript file and exit.
  --load <path>          Load a JavaScript task module in an async IIFE and exit.
  --call <name>          Call a function already loaded in the evaluator context.
  --call-args <json>     JSON object argument for --call. Default: {}.
  --library <query>      Print generated function docs for matching MCP tools.
  --limit <n>            Limit --library results. Default: 6.
  --artifact-dir <path>  Directory for api.saveArtifact(). Default: .mcp2repl/artifacts.
  --session <name>       Use a persistent local REPL session socket.
  --daemon               Run the named --session server in the foreground.
  --stop                 Stop the named --session server.
  --connect-timeout <s>  How long session clients wait for the socket. Default: 30.
  --json                 Print a compact JSON envelope instead of util.inspect text.
  --quiet                Pipe MCP server stderr instead of inheriting it.
  --max-output-chars <n> If output is larger, return ResultTooLarge with artifact handle and repair hints.
  --timeout <seconds>    Evaluation timeout. Default: 60.
  -h, --help             Show help.

Environment defaults:
  MCP2REPL_CONFIG, MCP2REPL_SERVER, MCP2REPL_SESSION, MCP2REPL_ARTIFACT_DIR
  MCP2REPL_TIMEOUT, MCP2REPL_MAX_OUTPUT_CHARS, MCP2REPL_JSON=1, MCP2REPL_QUIET=1

Injected globals:
  mcp.call(name, args)          Call by full tool name.
  mcp.<server>.<tool>(args)     Call namespaced tools when using mcpServers config.
  tools.safeName(args)          Call identifier-safe aliases.
  api.searchTools(query), api.describeTool(name), api.runtimeDocs()
  api.evalTool(nameOrQuery, fn, args) Auto-call eval/code/function-style MCP tools.
  api.project(value, projection), api.print(value, options) Create compact model-facing views.
  api.unwrap(value)                 Normalize MCP/Codex/result envelopes.
  api.saveArtifact(name, value), api.readArtifact(name), api.callTool(server, tool, args)
`);
}

function sessionSocketPath(name) {
  return path.resolve(".mcp2repl", "sessions", `${safeIdentifier(name)}.sock`);
}

async function sendSessionRequest(args, source) {
  const socketPath = sessionSocketPath(args.session);
  const payload = JSON.stringify({
    type: args.stop ? "stop" : "eval",
    source,
    json: args.json,
    maxOutputChars: args.maxOutputChars,
    timeoutMs: args.timeoutMs
  });

  const deadline = Date.now() + Number(args.connectTimeoutMs ?? 30000);

  return await new Promise((resolve, reject) => {
    const connect = () => {
      const socket = net.createConnection(socketPath);
      let data = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${payload}\n`));
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("error", (error) => {
        if (error?.code === "ENOENT" && Date.now() < deadline) {
          setTimeout(connect, 250);
          return;
        }
        reject(error);
      });
      socket.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Invalid session response from ${socketPath}: ${error.message}`));
        }
      });
    };
    connect();
  });
}

async function sessionSocketExists(name) {
  try {
    const stat = await fs.stat(sessionSocketPath(name));
    return stat.isSocket();
  } catch {
    return false;
  }
}

async function startDetachedSession(args) {
  if (!args.mock && !args.config && !args.command) return;

  const childArgs = [process.argv[1]];
  if (args.quiet) childArgs.push("--quiet");
  if (args.timeoutMs) childArgs.push("--timeout", String(args.timeoutMs / 1000));
  if (args.artifactDir) childArgs.push("--artifact-dir", args.artifactDir);
  if (args.mock) childArgs.push("--mock");
  if (args.config) childArgs.push("--config", args.config);
  if (args.server) childArgs.push("--server", args.server);
  if (args.command) childArgs.push("--command", args.command);
  for (const arg of args.args ?? []) childArgs.push("--arg", arg);
  childArgs.push("--session", args.session, "--daemon");

  await fs.mkdir(path.dirname(sessionSocketPath(args.session)), { recursive: true });
  const logPath = path.resolve(".mcp2repl", "sessions", `${safeIdentifier(args.session)}.log`);
  const log = await fs.open(logPath, "a");
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", log.fd, log.fd]
  });
  child.unref();
  await log.close();
}

async function runSessionDaemon(args) {
  const socketPath = sessionSocketPath(args.session);
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.rm(socketPath, { force: true });

  const client = await createClient(args);
  const repl = await new McpRepl(client, {
    timeoutMs: args.timeoutMs,
    artifactDir: args.artifactDir
  }).init();

  const server = net.createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        void handleSessionMessage(socket, data);
      }
    });
  });

  async function handleSessionMessage(socket, data) {
    socket.removeAllListeners("data");
    try {
      const request = JSON.parse(data.trim());
      if (request.type === "stop") {
        socket.end(JSON.stringify({ ok: true, stopped: true }));
        server.close();
        return;
      }

      const result = await repl.eval(request.source, { timeoutMs: request.timeoutMs });
      const response = await repl.formatResponse(result, {
        json: request.json,
        maxOutputChars: request.maxOutputChars
      });
      socket.end(JSON.stringify({ ok: true, response }));
    } catch (error) {
      socket.end(JSON.stringify({
        ok: false,
        error: repairErrorEnvelope(error)
      }));
    }
  }

  server.on("close", async () => {
    await repl.close();
    await fs.rm(socketPath, { force: true });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  output.write(`mcp2repl session '${args.session}' listening at ${socketPath}\n`);
}

async function readSource(args) {
  if (args.call) return buildCallSource(args);
  if (args.load) return buildLoadSource(args.load);
  if (args.eval != null) return args.eval === "-" ? readStdin() : args.eval;
  if (args.file) return fs.readFile(args.file, "utf8");
  if (!process.stdin.isTTY) return readStdin();
  return null;
}

async function buildLoadSource(filePath) {
  return `return await api.load(${JSON.stringify(path.resolve(filePath))})`;
}

function buildCallSource(args) {
  return buildCallSourceFrom(args.call, parseCallArgs(args.callArgs));
}

function parseCallArgs(raw) {
  let callArgs = {};
  if (raw != null) {
    callArgs = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (callArgs == null || Array.isArray(callArgs) || typeof callArgs !== "object") {
      throw new TypeError("--call-args must be a JSON object");
    }
  }
  return callArgs;
}

function buildCallSourceFrom(call, callArgs = {}) {
  return `return await __mcp2replCall(${JSON.stringify(call)}, ${JSON.stringify(callArgs)})`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.quiet) process.env.MCP2REPL_QUIET = "1";

  if (args.session && args.daemon) {
    await runSessionDaemon(args);
    return;
  }

  if (args.session && !args.daemon) {
    const source = args.stop ? "" : await readSource(args);
    if (!args.stop && source == null) {
      throw new Error("--session client mode requires --eval, --file, --load, --call, stdin, or --stop");
    }
    if (!args.stop && !(await sessionSocketExists(args.session))) {
      await startDetachedSession(args);
    }
    const response = await sendSessionRequest(args, source);
    if (!response.ok) {
      const text = args.json
        ? JSON.stringify({ ok: false, error: response.error })
        : formatSessionError(response.error);
      const stream = args.json ? process.stdout : process.stderr;
      stream.write(`${text}\n`);
      process.exitCode = 1;
      return;
    }
    if (response.response != null) process.stdout.write(`${response.response}\n`);
    else process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }

  const client = await createClient(args);
  const repl = await new McpRepl(client, {
    timeoutMs: args.timeoutMs,
    artifactDir: args.artifactDir
  }).init();

  try {
    if (args.library != null) {
      const result = repl.context.api.library(args.library, { limit: args.limit });
      process.stdout.write(`${await repl.formatResponse(result, {
        json: args.json,
        maxOutputChars: args.maxOutputChars
      })}\n`);
      return;
    }

    const source = await readSource(args);
    if (source != null) {
      const result = await repl.eval(source);
      process.stdout.write(`${await repl.formatResponse(result, {
        json: args.json,
        maxOutputChars: args.maxOutputChars
      })}\n`);
      return;
    }

    const rl = readline.createInterface({ input, output });
    output.write("mcp2repl ready. Use tools.safeName(args), api.searchTools(query), or api.describeTool(name).\n");
    output.write("Type .help, .tools, .search <query>, .describe <server>.<tool>, .exit.\n");

    while (true) {
      const line = await rl.question("> ");
      if (line.trim() === ".exit") break;
      if (line.trim() === ".tools") {
        output.write(`${formatResult(repl.context.api.listTools({ schemas: false }))}\n`);
        continue;
      }
      if (line.trim() === ".help") {
        output.write(`${repl.context.api.runtimeDocs()}\n`);
        continue;
      }
      if (line.trim().startsWith(".search ")) {
        const query = line.trim().slice(".search ".length);
        output.write(`${formatResult(repl.context.api.searchTools(query))}\n`);
        continue;
      }
      if (line.trim().startsWith(".describe ")) {
        const spec = line.trim().slice(".describe ".length);
        output.write(`${formatResult(repl.context.api.describeTool(spec))}\n`);
        continue;
      }
      try {
        const result = await repl.eval(line);
        output.write(`${formatResult(result)}\n`);
      } catch (error) {
        output.write(`${error.stack ?? error.message}\n`);
      }
    }
    rl.close();
  } catch (error) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: repairErrorEnvelope(error) })}\n`);
    } else {
      process.stderr.write(`${formatSessionError(repairErrorEnvelope(error))}\n`);
    }
    process.exitCode = 1;
  } finally {
    await repl.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

function formatSessionError(error) {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return String(error);
  return [
    `${error.name ?? "Error"}: ${error.message ?? ""}`.trim(),
    error.repairHint ? `Repair hint: ${error.repairHint}` : null,
    error.context ? `Context: ${JSON.stringify(error.context)}` : null,
    error.stack
  ].filter(Boolean).join("\n");
}
