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
    } else if (arg === "--eval" || arg === "-e") {
      const source = argv[++i];
      args.eval = args.eval == null ? source : `${args.eval}\n${source}`;
    }
    else if (arg === "--file" || arg === "-f") args.file = argv[++i];
    else if (arg === "--load") args.load = argv[++i];
    else if (arg === "--call") args.call = argv[++i];
    else if (arg === "--call-args") args.callArgs = argv[++i];
    else if (arg === "--library") args.library = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--artifact-dir") args.artifactDir = argv[++i];
    else if (arg === "--session") args.session = argv[++i];
    else if (arg === "--daemon") args.daemon = true;
    else if (arg === "--stop") args.stop = true;
    else if (arg === "--connect-timeout") args.connectTimeoutMs = Number(argv[++i]) * 1000;
    else if (arg === "--json") args.json = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--max-output-chars") args.maxOutputChars = Number(argv[++i]);
    else if (arg === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
    else args._.push(arg);
  }

  return applyEnvDefaults(args);
}

function applyEnvDefaults(args) {
  const env = process.env;
  args.config ??= env.MCP2REPL_CONFIG;
  args.server ??= env.MCP2REPL_SERVER;
  args.session ??= env.MCP2REPL_SESSION;
  args.artifactDir ??= env.MCP2REPL_ARTIFACT_DIR;
  if (args.timeoutMs == null && env.MCP2REPL_TIMEOUT) args.timeoutMs = Number(env.MCP2REPL_TIMEOUT) * 1000;
  if (args.connectTimeoutMs == null && env.MCP2REPL_CONNECT_TIMEOUT) args.connectTimeoutMs = Number(env.MCP2REPL_CONNECT_TIMEOUT) * 1000;
  if (args.maxOutputChars == null && env.MCP2REPL_MAX_OUTPUT_CHARS) args.maxOutputChars = Number(env.MCP2REPL_MAX_OUTPUT_CHARS);
  if (args.limit == null && env.MCP2REPL_LIMIT) args.limit = Number(env.MCP2REPL_LIMIT);
  if (args.command == null && env.MCP2REPL_COMMAND) args.command = env.MCP2REPL_COMMAND;
  if (args.args == null && env.MCP2REPL_ARGS) args.args = JSON.parse(env.MCP2REPL_ARGS);
  if (args.json == null && envFlag(env.MCP2REPL_JSON)) args.json = true;
  if (args.quiet == null && envFlag(env.MCP2REPL_QUIET)) args.quiet = true;
  return args;
}

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}
