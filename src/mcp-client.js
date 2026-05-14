import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function safeIdentifier(name) {
  let id = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(id)) id = `_${id}`;
  return id || "tool";
}

export async function connectStdioMcp(spec) {
  if (!spec?.command) {
    throw new Error("MCP server spec requires a command");
  }

  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...process.env, ...(spec.env ?? {}) },
    cwd: spec.cwd ?? process.cwd(),
    stderr: spec.stderr ?? (process.env.MCP2REPL_QUIET === "1" ? "pipe" : undefined)
  });

  const client = new Client(
    { name: "mcp2repl", version: "0.0.1" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    close: async () => {
      transport._process?.kill?.();
      try {
        await withCloseTimeout(client.close(), 1000);
      } finally {
        await withCloseTimeout(transport.close?.(), 1000);
      }
    }
  };
}

async function withCloseTimeout(promise, ms) {
  if (!promise) return;
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function connectStdioMcps(specs) {
  const entries = [];

  for (const [serverName, spec] of Object.entries(specs)) {
    const connected = await connectStdioMcp(spec);
    const listed = await connected.client.listTools();
    entries.push({
      serverName,
      connected,
      tools: listed.tools ?? []
    });
  }

  const toolMap = new Map();
  for (const entry of entries) {
    for (const tool of entry.tools) {
      const fullName = `${entry.serverName}.${tool.name}`;
      toolMap.set(fullName, { entry, tool });
    }
  }

  return {
    client: {
      async listTools() {
        return {
          tools: entries.flatMap((entry) => entry.tools.map((tool) => ({
            ...tool,
            name: `${entry.serverName}.${tool.name}`,
            _mcp2repl: {
              server: entry.serverName,
              name: tool.name
            }
          })))
        };
      },
      async callTool(request) {
        const fullName = request.name ?? request.params?.name;
        const match = toolMap.get(fullName);
        if (!match) {
          throw new Error(`Unknown MCP tool: ${fullName}`);
        }
        return match.entry.connected.client.callTool({
          name: match.tool.name,
          arguments: request.arguments ?? request.params?.arguments ?? {}
        });
      }
    },
    close: async () => {
      await Promise.all(entries.map((entry) => entry.connected.close()));
    }
  };
}

export async function createToolFacade(client) {
  const listed = await client.listTools();
  const tools = listed.tools ?? [];
  const byName = {};
  const bySafeName = {};
  const byServer = {};
  const toolByServerAndName = new Map();
  const collisions = new Map();
  const serverAliases = new Map();
  const serverAliasCounts = new Map();

  for (const tool of tools) {
    const meta = tool._mcp2repl;
    byName[tool.name] = async (args = {}) => {
      try {
        assertToolArguments(tool, args);
        const result = await client.callTool({
          name: tool.name,
          arguments: args
        });
        return simplifyToolResult(result);
      } catch (error) {
        throw attachToolContext(error, tool, args);
      }
    };

    let safe = safeIdentifier(tool.name);
    const count = collisions.get(safe) ?? 0;
    collisions.set(safe, count + 1);
    if (count > 0) safe = `${safe}_${count + 1}`;
    tool._mcp2replSafeName = safe;
    bySafeName[safe] = byName[tool.name];

    if (meta?.server && meta?.name) {
      const safeServer = getStableSafeServerName(meta.server, serverAliases, serverAliasCounts);

      byServer[safeServer] ??= {};
      byServer[safeServer][safeIdentifier(meta.name)] = byName[tool.name];
      toolByServerAndName.set(`${meta.server}\u0000${meta.name}`, byName[tool.name]);
    }
  }

  return {
    list: tools,
    byName,
    bySafeName,
    byServer,
    callServerTool: async (server, name, args = {}) => {
      const fn = toolByServerAndName.get(`${server}\u0000${name}`);
      if (!fn) throw new Error(`Unknown MCP tool: ${server}.${name}`);
      return fn(args);
    },
    describeTool: (server, name) => tools.find((tool) => {
      const meta = tool._mcp2repl;
      if (meta) return meta.server === server && meta.name === name;
      return server == null && tool.name === name;
    })
  };
}

function attachToolContext(error, tool, args) {
  error.mcp2repl = {
    kind: "mcp-tool-call",
    tool: tool.name,
    safeName: tool._mcp2replSafeName,
    server: tool._mcp2repl?.server,
    upstreamName: tool._mcp2repl?.name,
    attemptedKeys: Object.keys(args ?? {}),
    schema: tool.inputSchema ?? { type: "object" },
    call: `await tools.${tool._mcp2replSafeName ?? safeIdentifier(tool.name)}({ ...args })`,
    repairHint: "Repair the primitive procedure argument object using this schema. Pass exactly one object and avoid unsupported keys."
  };
  return error;
}

function assertToolArguments(tool, args) {
  if (args == null || Array.isArray(args) || typeof args !== "object") {
    throw new TypeError([
      `MCP tool '${tool.name}' expects a single argument object.`,
      `Call it like: tools.${safeIdentifier(tool.name)}({ ...args }).`,
      `Input schema: ${JSON.stringify(tool.inputSchema ?? { type: "object" })}`
    ].join(" "));
  }
}

function getStableSafeServerName(serverName, aliases, counts) {
  const existing = aliases.get(serverName);
  if (existing) return existing;

  const base = safeIdentifier(serverName);
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  const alias = count === 0 ? base : `${base}_${count + 1}`;
  aliases.set(serverName, alias);
  return alias;
}

export function simplifyToolResult(result) {
  if (!result || !Array.isArray(result.content)) return result;

  if (result.content.length === 1) {
    const item = result.content[0];
    if (item.type === "text") {
      return parseStructuredText(item.text);
    }
  }

  return result;
}

function parseStructuredText(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const fencedJson = String(text).match(/```json\s*([\s\S]*?)\s*```/i);
  if (fencedJson) {
    try {
      return JSON.parse(fencedJson[1]);
    } catch {}
  }

  return text;
}

export function createMockClient() {
  const calls = [];

  return {
    calls,
    async listTools() {
      return {
        tools: [
          {
            name: "math.add",
            description: "Add two numbers",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" }
              },
              required: ["a", "b"]
            }
          },
          {
            name: "page.title",
            description: "Return a fake browser page title",
            inputSchema: { type: "object", properties: {} }
          }
        ]
      };
    },
    async callTool(request) {
      calls.push(request);
      if (request.name === "math.add") {
        return {
          content: [
            {
              type: "text",
              text: String(request.arguments.a + request.arguments.b)
            }
          ]
        };
      }
      if (request.name === "page.title") {
        return {
          content: [
            {
              type: "text",
              text: "Mock Browser"
            }
          ]
        };
      }
      throw new Error(`Unknown mock tool: ${request.name}`);
    },
    async close() {}
  };
}
