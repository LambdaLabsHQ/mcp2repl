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
    cwd: spec.cwd ?? process.cwd()
  });

  const client = new Client(
    { name: "mcp2repl", version: "0.0.1" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    }
  };
}

export async function createToolFacade(client) {
  const listed = await client.listTools();
  const tools = listed.tools ?? [];
  const byName = {};
  const bySafeName = {};
  const collisions = new Map();

  for (const tool of tools) {
    byName[tool.name] = async (args = {}) => {
      const result = await client.callTool({
        name: tool.name,
        arguments: args
      });
      return simplifyToolResult(result);
    };

    let safe = safeIdentifier(tool.name);
    const count = collisions.get(safe) ?? 0;
    collisions.set(safe, count + 1);
    if (count > 0) safe = `${safe}_${count + 1}`;
    bySafeName[safe] = byName[tool.name];
  }

  return {
    list: tools,
    byName,
    bySafeName
  };
}

export function simplifyToolResult(result) {
  if (!result || !Array.isArray(result.content)) return result;

  if (result.content.length === 1) {
    const item = result.content[0];
    if (item.type === "text") {
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
  }

  return result;
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
