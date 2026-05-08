#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, parseArgs } from "./config.js";
import { connectStdioMcp, createMockClient } from "./mcp-client.js";
import { formatResult, McpRepl } from "./evaluator.js";

function wrapConnectedClient(connected) {
  return {
    listTools: (...args) => connected.client.listTools(...args),
    callTool: (...args) => connected.client.callTool(...args),
    close: connected.close
  };
}

async function createClient(args) {
  if (args.mock) return createMockClient();

  if (args.config) {
    const { spec } = await loadConfig(args.config, args.server);
    const connected = await connectStdioMcp(spec);
    return wrapConnectedClient(connected);
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

async function readSource(args) {
  if (args.eval != null) return args.eval;
  if (args.file) return fs.readFile(args.file, "utf8");
  if (!process.stdin.isTTY) return fs.readFile(0, "utf8");
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await createClient(args);
  const repl = await new McpRepl(client, {
    timeoutMs: args.timeoutMs
  }).init();

  try {
    const source = await readSource(args);
    if (source != null) {
      const result = await repl.eval(source);
      process.stdout.write(`${formatResult(result)}\n`);
      return;
    }

    const rl = readline.createInterface({ input, output });
    output.write("mcp2repl ready. Use mcp.call(name,args), mcp.tools[name](args), or tools.safeName(args).\n");
    output.write("Type .tools to list tools, .exit to quit.\n");

    while (true) {
      const line = await rl.question("> ");
      if (line.trim() === ".exit") break;
      if (line.trim() === ".tools") {
        output.write(`${formatResult(repl.context.mcp.listTools())}\n`);
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
  } finally {
    await repl.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
