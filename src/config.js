import fs from "node:fs/promises";

export async function loadConfig(path, serverName) {
  const json = JSON.parse(await fs.readFile(path, "utf8"));

  if (json.mcpServers) {
    if (serverName) {
      if (!json.mcpServers[serverName]) {
        throw new Error(`MCP server not found in config: ${serverName}`);
      }
      return { name: serverName, spec: json.mcpServers[serverName] };
    }

    const specs = Object.fromEntries(
      Object.entries(json.mcpServers).filter(([, spec]) => !spec.disabled)
    );
    if (Object.keys(specs).length === 0) {
      throw new Error(`MCP server not found in config: ${serverName}`);
    }
    return { specs };
  }

  return { name: serverName ?? "default", spec: json };
}

export function parseArgs(argv) {
  const args = {
    _: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mock") args.mock = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--config") args.config = argv[++i];
    else if (arg === "--server") args.server = argv[++i];
    else if (arg === "--command") args.command = argv[++i];
    else if (arg === "--arg") {
      args.args ??= [];
      args.args.push(argv[++i]);
    } else if (arg === "--eval" || arg === "-e") args.eval = argv[++i];
    else if (arg === "--file" || arg === "-f") args.file = argv[++i];
    else if (arg === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
    else args._.push(arg);
  }

  return args;
}
