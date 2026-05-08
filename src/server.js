#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
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

const args = parseArgs(process.argv.slice(2));
const upstreamClient = await createClient(args);
const repl = await new McpRepl(upstreamClient, {
  timeoutMs: args.timeoutMs
}).init();

const server = new Server(
  {
    name: "mcp2repl",
    version: "0.0.1"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "eval",
      description: "Evaluate JavaScript in a persistent REPL with upstream MCP tools injected as mcp and tools.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript source to evaluate. Use mcp.call(name,args), mcp.tools[name](args), or tools.safeName(args)."
          }
        },
        required: ["code"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "eval") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const result = await repl.eval(request.params.arguments?.code ?? "");
  return {
    content: [
      {
        type: "text",
        text: formatResult(result)
      }
    ]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  await repl.close();
  process.exit(130);
});
