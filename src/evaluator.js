import vm from "node:vm";
import util from "node:util";
import { createToolFacade } from "./mcp-client.js";

export class McpRepl {
  constructor(client, options = {}) {
    this.client = client;
    this.options = options;
    this.context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      process: {
        env: process.env,
        cwd: process.cwd,
        version: process.version,
        versions: process.versions,
        platform: process.platform
      }
    });
  }

  async init() {
    const facade = await createToolFacade(this.client);
    this.facade = facade;

    const mcp = {
      call: async (name, args = {}) => facade.byName[name](args),
      tools: facade.byName,
      listTools: () => facade.list.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        server: tool._mcp2repl?.server,
        upstreamName: tool._mcp2repl?.name
      }))
    };
    Object.assign(mcp, facade.byServer);

    this.context.mcp = mcp;
    this.context.api = {
      callTool: (server, name, args = {}) => facade.callServerTool(server, name, args),
      listTools: mcp.listTools,
      describeTool: (server, name) => facade.describeTool(server, name)
    };
    this.context.tools = facade.bySafeName;
    this.context.inspect = (value) => util.inspect(value, {
      depth: 8,
      colors: false,
      maxArrayLength: 200
    });
    this.context.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    return this;
  }

  async eval(source, options = {}) {
    const code = String(source ?? "");
    const timeout = options.timeoutMs ?? this.options.timeoutMs ?? 60000;
    const script = this.#compile(code, timeout);
    const value = script.runInContext(this.context, { timeout });
    return await withTimeout(Promise.resolve(value), timeout);
  }

  async close() {
    await this.client.close?.();
  }

  #compile(code, timeout) {
    const candidates = [
      code,
      `(async () => (${code}))()`,
      `(async () => {\n${code}\n})()`
    ];

    let lastSyntaxError;
    for (const candidate of candidates) {
      try {
        return new vm.Script(candidate, { timeout, displayErrors: true });
      } catch (error) {
        if (error?.name !== "SyntaxError") throw error;
        lastSyntaxError = error;
      }
    }
    throw lastSyntaxError;
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function formatResult(value) {
  if (value === undefined) return "(ok)";
  if (typeof value === "string") return value;
  return util.inspect(value, {
    depth: 8,
    colors: false,
    maxArrayLength: 200
  });
}
