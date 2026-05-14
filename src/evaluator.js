import vm from "node:vm";
import util from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
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
    this.toolDocs = createToolDocs(facade.list);
    this.artifactDir = path.resolve(this.options.artifactDir ?? ".mcp2repl/artifacts");

    const mcp = {
      call: async (name, args = {}) => facade.byName[name](args),
      tools: facade.byName,
      listTools: (options = {}) => listTools(facade.list, options)
    };
    Object.assign(mcp, facade.byServer);

    this.context.mcp = mcp;
    const api = {
      callTool: (server, name, args = {}) => facade.callServerTool(server, name, args),
      listTools: mcp.listTools,
      searchTools: (query, options = {}) => searchTools(this.toolDocs, query, options),
      describeTool: (serverOrName, name) => describeTool(facade, serverOrName, name),
      guide: (query = "", options = {}) => guideTools(this.toolDocs, query, options),
      library: (query = "", options = {}) => libraryDocs(this.toolDocs, query, options),
      evalTool: (nameOrQuery, fn, args = {}) => evalTool(facade, this.toolDocs, nameOrQuery, fn, args),
      compact: (value, options = {}) => compactValue(value, options),
      unwrap: (value) => unwrapResult(value),
      load: (filePath) => this.#loadFile(filePath),
      runtimeDocs: () => runtimeDocs(),
      saveArtifact: (name, value, options = {}) => this.#saveArtifact(name, value, options),
      readArtifact: (name) => this.#readArtifact(name)
    };
    this.context.api = api;
    this.context.tools = facade.bySafeName;
    this.context.inspect = (value) => util.inspect(value, {
      depth: 8,
      colors: false,
      maxArrayLength: 200
    });
    this.context.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.context.__mcp2replCall = async (name, args = {}) => {
      const fn = resolveContextPath(this.context, name);
      if (typeof fn !== "function") {
        throw new TypeError(`No callable function found at '${name}'`);
      }
      return await fn(args);
    };

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

  async #loadFile(filePath) {
    const resolved = path.resolve(filePath);
    const code = await fs.readFile(resolved, "utf8");
    return await this.eval([
      "return await (async () => {",
      code,
      `\nreturn { loaded: ${JSON.stringify(resolved)} };`,
      "})()"
    ].join("\n"));
  }

  async formatResponse(value, options = {}) {
    const maxOutputChars = Number.isFinite(options.maxOutputChars)
      ? options.maxOutputChars
      : this.options.maxOutputChars;
    const envelope = await this.#responseEnvelope(value, { maxOutputChars });
    if (options.json) return JSON.stringify(envelope);
    if (envelope.artifact) return JSON.stringify(envelope);
    return formatResult(value);
  }

  async #saveArtifact(name, value, options = {}) {
    await fs.mkdir(this.artifactDir, { recursive: true });
    const safeName = safeArtifactName(name);
    const filePath = path.join(this.artifactDir, safeName);
    const format = options.format ?? inferArtifactFormat(safeName, value);
    const data = formatArtifact(value, format);
    await fs.writeFile(filePath, data);
    return {
      path: filePath,
      bytes: Buffer.byteLength(data),
      format
    };
  }

  async #readArtifact(name) {
    const safeName = safeArtifactName(name);
    const filePath = path.join(this.artifactDir, safeName);
    const text = await fs.readFile(filePath, "utf8");
    const parsed = parseJsonLike(text);
    return parsed.parsed ? parsed.value : text;
  }

  async #responseEnvelope(value, options = {}) {
    const text = value === undefined ? "undefined" : JSON.stringify(value);
    const maxOutputChars = Number(options.maxOutputChars ?? 0);
    if (maxOutputChars > 0 && text.length > maxOutputChars) {
      const saved = await this.#saveArtifact("result.json", value, { format: "json" });
      return {
        ok: true,
        artifact: saved,
        truncated: true,
        summary: summarizeValue(value)
      };
    }

    return {
      ok: true,
      result: value
    };
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

function resolveContextPath(context, name) {
  const parts = String(name ?? "").split(".").filter(Boolean);
  let value = context;
  for (const part of parts) {
    value = value?.[part];
  }
  return value;
}

function runtimeDocs() {
  return [
    "mcp2repl runtime contract:",
    "- Write JavaScript, including await, loops, helper functions, try/catch, arrays, maps, and objects.",
    "- Call upstream MCP tools as library functions: await tools.safeName({ ...args }).",
    "- Tool calls are async. Discovery helpers such as api.searchTools(), api.describeTool(), api.guide(), api.library(), and api.runtimeDocs() return plain values.",
    "- Discover tools at runtime instead of loading every schema into prompt context:",
    "  api.searchTools(query, { limit? }) -> short ranked tool summaries.",
    "  api.describeTool(name) or api.describeTool(server, tool) -> one full schema plus call hints.",
    "  api.guide(query, { limit? }) -> compact recipes, call forms, and common pitfalls.",
    "  api.library(query, { limit? }) -> TypeScript-like semantic function docs for selected tools.",
    "  api.evalTool(nameOrQuery, fn, args?) -> call a code/function/script-style MCP tool with schema-safe argument embedding.",
    "  api.listTools({ schemas: false }) -> compact tool index.",
    "  api.unwrap(value) -> normalizes common MCP/Codex/result envelopes and parses JSON strings when possible.",
    "  api.load(path) -> loads a JavaScript file into the same evaluator context using an async IIFE.",
    "- Store large intermediate data outside model context:",
    "  await api.saveArtifact('snapshot.json', value) -> { path, bytes, format }.",
    "  await api.readArtifact('snapshot.json') -> reads a saved artifact back into the evaluator.",
    "  api.compact(value, { maxArray?, maxString? }) -> recursively trims large data before returning it.",
    "- Use mcp.call(exactToolName, args) when safe aliases collide or exact names are easier.",
    "- Return only the compact final value the model needs to see."
  ].join("\n");
}

function listTools(tools, options = {}) {
  const includeSchemas = options.schemas !== false;
  return tools.map((tool) => {
    const listed = {
      name: tool.name,
      safeName: tool._mcp2replSafeName,
      description: tool.description,
      server: tool._mcp2repl?.server,
      upstreamName: tool._mcp2repl?.name
    };
    if (includeSchemas) listed.inputSchema = tool.inputSchema;
    return listed;
  });
}

function createToolDocs(tools) {
  return tools.map((tool) => {
    const schemaText = summarizeSchemaForSearch(tool.inputSchema);
    const server = tool._mcp2repl?.server;
    const upstreamName = tool._mcp2repl?.name;
    const semantic = createSemanticDoc(tool);
    return {
      name: tool.name,
      safeName: tool._mcp2replSafeName,
      server,
      upstreamName,
      description: tool.description ?? "",
      inputKeys: getSchemaKeys(tool.inputSchema),
      semantic,
      searchText: [
        tool.name,
        tool._mcp2replSafeName,
        server,
        upstreamName,
        tool.description,
        schemaText,
        semantic.text
      ].filter(Boolean).join(" ").toLowerCase(),
      tool
    };
  });
}

function searchTools(docs, query, options = {}) {
  const terms = tokenize(query);
  const limit = Math.max(1, Math.min(Number(options.limit ?? 8), 50));
  if (terms.length === 0) {
    return docs.slice(0, limit).map(formatToolSearchResult);
  }

  return docs
    .map((doc) => ({ doc, score: scoreToolDoc(doc, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name))
    .slice(0, limit)
    .map((entry) => ({
      ...formatToolSearchResult(entry.doc),
      score: entry.score
    }));
}

function formatToolSearchResult(doc) {
  return {
    name: doc.name,
    safeName: doc.safeName,
    server: doc.server,
    upstreamName: doc.upstreamName,
    description: doc.description,
    inputKeys: doc.inputKeys,
    signature: doc.semantic.signature,
    call: doc.semantic.call,
    notes: doc.semantic.notes
  };
}

function guideTools(docs, query = "", options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 6), 20));
  const tools = searchTools(docs, query, { limit }).map((tool) => ({
    name: tool.name,
    safeName: tool.safeName,
    description: tool.description,
    inputKeys: tool.inputKeys,
    signature: tool.signature,
    call: tool.call,
    notes: tool.notes
  }));

  return {
    runtime: runtimeDocs(),
    tools,
    patterns: guidePatterns(query)
  };
}

function libraryDocs(docs, query = "", options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 6), 100));
  const selected = query
    ? searchTools(docs, query, { limit }).map((match) => docs.find((doc) => doc.name === match.name))
    : docs.slice(0, limit);
  const verbose = options.verbose === true;
  return selected.filter(Boolean).map((doc) => verbose ? doc.semantic : doc.semantic.text);
}

function scoreToolDoc(doc, terms) {
  let score = 0;
  const nameText = `${doc.name} ${doc.safeName ?? ""} ${doc.upstreamName ?? ""}`.toLowerCase();
  for (const term of terms) {
    if (nameText === term) score += 25;
    else if (nameText.includes(term)) score += 10;
    if (doc.searchText.includes(term)) score += 2;
  }
  return score;
}

function describeTool(facade, serverOrName, name) {
  if (name != null) return enrichTool(facade.describeTool(serverOrName, name));

  const spec = String(serverOrName ?? "");
  const exact = facade.list.find((tool) => tool.name === spec || tool._mcp2replSafeName === spec);
  if (exact) return enrichTool(exact);

  const [server, ...toolParts] = spec.split(".");
  const toolName = toolParts.join(".");
  return enrichTool(facade.describeTool(server, toolName));
}

function enrichTool(tool) {
  if (!tool) return tool;
  const semantic = createSemanticDoc(tool);
  return {
    ...tool,
    _mcp2repl: {
      ...(tool._mcp2repl ?? {}),
      safeName: tool._mcp2replSafeName,
      signature: semantic.signature,
      call: semantic.call,
      params: semantic.params,
      notes: semantic.notes
    }
  };
}

function createSemanticDoc(tool) {
  const safeName = tool._mcp2replSafeName ?? safeIdentifierLike(tool.name);
  const schema = normalizeObjectSchema(tool.inputSchema);
  const params = schemaProperties(schema).map(([name, property]) => describeParam(name, property, schema));
  const signatureBody = params.length === 0
    ? "{}"
    : `{ ${params.map((param) => `${param.name}${param.required ? "" : "?"}: ${param.type}`).join("; ")} }`;
  const exampleParams = params.some((param) => param.required)
    ? params.filter((param) => param.required)
    : chooseExampleParams(params);
  const callBody = params.length === 0
    ? "{}"
    : `{ ${exampleParams.map((param) => `${param.name}: ${param.example}`).join(", ")} }`;
  const signature = `async function ${safeName}(args: ${signatureBody}): Promise<unknown>`;
  const notes = [
    "Pass exactly one object argument. Unknown keys may be rejected when the MCP schema sets additionalProperties: false.",
    "The returned value is the MCP result after mcp2repl unwraps a single text/JSON content item when possible."
  ];

  if (schema.additionalProperties === false) {
    notes.push("This tool's schema disallows additional properties.");
  }
  if (params.some((param) => param.enumValues?.length)) {
    notes.push("Use only the documented enum values for enum parameters.");
  }

  const lines = [
    `${signature}`,
    tool.description ? `Description: ${shortText(tool.description, 180)}` : null,
    params.length > 0 ? "Parameters:" : "Parameters: none",
    ...params.map((param) => `- ${param.name}${param.required ? " (required)" : " (optional)"}: ${param.type}${param.description ? ` - ${shortText(param.description, 180)}` : ""}`),
    `Call: await tools.${safeName}(${callBody})`,
    `Original MCP tool: ${tool.name}`
  ].filter(Boolean);

  return {
    signature,
    call: `await tools.${safeName}(${callBody})`,
    params,
    notes,
    text: lines.join("\n")
  };
}

function guidePatterns(query) {
  return [
    "Keep loops, polling, retries, extraction, and aggregation inside JavaScript; return compact JSON.",
    "Call api.describeTool(name) before using an unfamiliar tool with nontrivial arguments.",
    "Use api.library(query) when you want TypeScript-like function signatures generated from MCP schemas.",
    "Use api.evalTool(nameOrQuery, fn, args) for MCP tools whose schema accepts JavaScript/code/function text; do not invent unsupported args keys.",
    "If a result shape is uncertain, run a tiny probe first and encode the observed shape into the script.",
    "Use api.saveArtifact(name, value) for large intermediate data instead of returning it to the model."
  ];
}

async function evalTool(facade, docs, nameOrQuery, fn, args = {}) {
  const tool = resolveEvalTool(facade, docs, nameOrQuery);
  const codeKey = findCodeParameter(tool);
  if (!codeKey) {
    throw new Error(`Tool '${tool.name}' does not expose a string code/function/script parameter`);
  }

  const source = typeof fn === "function" ? fn.toString() : String(fn);
  const callSource = [
    "() => {",
    `  const __mcp2replArgs = ${JSON.stringify(args ?? {})};`,
    `  const __mcp2replFn = (${source});`,
    "  return __mcp2replFn(__mcp2replArgs);",
    "}"
  ].join("\n");

  const result = await facade.byName[tool.name]({ [codeKey]: callSource });
  return unwrapResult(result);
}

function resolveEvalTool(facade, docs, nameOrQuery) {
  const spec = String(nameOrQuery ?? "").trim();
  const exact = facade.list.find((tool) => (
    tool.name === spec ||
    tool._mcp2replSafeName === spec ||
    tool._mcp2repl?.name === spec ||
    `${tool._mcp2repl?.server}.${tool._mcp2repl?.name}` === spec
  ));
  if (exact) return exact;

  const matches = searchTools(docs, spec || "evaluate script code function", { limit: 20 })
    .map((match) => docs.find((doc) => doc.name === match.name)?.tool)
    .filter(Boolean)
    .filter((tool) => findCodeParameter(tool));
  if (matches[0]) return matches[0];

  throw new Error(`No eval-style MCP tool found for '${spec}'`);
}

function findCodeParameter(tool) {
  const schema = normalizeObjectSchema(tool.inputSchema);
  const entries = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const scored = entries
    .filter(([, property]) => property?.type === "string" || !property?.type)
    .map(([name, property], index) => {
      const text = `${name} ${property?.title ?? ""} ${property?.description ?? ""}`.toLowerCase();
      let score = 0;
      if (/^(function|script|code|javascript|js)$/.test(name.toLowerCase())) score += 20;
      if (/function|script|code|javascript|js/.test(text)) score += 10;
      if (required.has(name)) score += 5;
      return { name, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.name;
}

function unwrapResult(value) {
  if (typeof value === "string") {
    const parsed = parseJsonLike(value);
    return parsed.parsed ? unwrapResult(parsed.value) : value;
  }
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value.content) && value.content.length === 1) {
    const item = value.content[0];
    if (item?.type === "text") return unwrapResult(item.text);
  }

  if (Object.prototype.hasOwnProperty.call(value, "response")) {
    return unwrapResult(value.response);
  }
  if (Object.prototype.hasOwnProperty.call(value, "result")) {
    return unwrapResult(value.result);
  }
  if (Object.prototype.hasOwnProperty.call(value, "text") && Object.keys(value).length <= 2) {
    return unwrapResult(value.text);
  }
  return value;
}

function parseJsonLike(text) {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {}

  const fencedJson = String(text).match(/```json\s*([\s\S]*?)\s*```/i);
  if (fencedJson) {
    try {
      return { parsed: true, value: JSON.parse(fencedJson[1]) };
    } catch {}
  }
  return { parsed: false, value: text };
}

function safeIdentifierLike(name) {
  let id = String(name ?? "tool").replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(id)) id = `_${id}`;
  return id || "tool";
}

function normalizeObjectSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  if (schema.type === "object" || schema.properties) return schema;
  return { type: "object", properties: {}, description: schema.description };
}

function schemaProperties(schema) {
  return Object.entries(schema.properties ?? {});
}

function describeParam(name, property, parentSchema) {
  const required = Array.isArray(parentSchema.required) && parentSchema.required.includes(name);
  return {
    name,
    required,
    type: schemaToType(property),
    description: paramDescription(property),
    enumValues: Array.isArray(property?.enum) ? property.enum : undefined,
    example: exampleForSchema(property, name)
  };
}

function chooseExampleParams(params) {
  const scored = params
    .map((param, index) => ({ param, index, score: exampleParamScore(param) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored.filter((entry) => entry.score > 0).slice(0, 3);
  return (selected.length > 0 ? selected : scored.slice(0, 2)).map((entry) => entry.param);
}

function exampleParamScore(param) {
  const text = `${param.name} ${param.description}`.toLowerCase();
  let score = 0;
  if (/url|uri|href|path|file|query|search|id|uid|name|text|code|function|command/.test(text)) score += 5;
  if (/timeout|limit|page|size|count/.test(text)) score += 2;
  if (param.enumValues?.length) score += 1;
  return score;
}

function paramDescription(schema) {
  const parts = [];
  if (schema?.description) parts.push(schema.description);
  if (schema?.items?.description) parts.push(`Items: ${schema.items.description}`);
  return parts.join(" ");
}

function schemaToType(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => schemaToType({ ...schema, type })).join(" | ");
  }
  if (schema.anyOf) return schema.anyOf.map(schemaToType).join(" | ");
  if (schema.oneOf) return schema.oneOf.map(schemaToType).join(" | ");
  if (schema.allOf) return schema.allOf.map(schemaToType).join(" & ");

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${schemaToType(schema.items ?? {})}[]`;
    case "object": {
      const entries = Object.entries(schema.properties ?? {});
      if (entries.length === 0) return "Record<string, unknown>";
      const required = new Set(schema.required ?? []);
      return `{ ${entries.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${schemaToType(value)}`).join("; ")} }`;
    }
    default:
      if (schema.properties) return schemaToType({ ...schema, type: "object" });
      if (schema.items) return `${schemaToType(schema.items)}[]`;
      return "unknown";
  }
}

function exampleForSchema(schema, name = "value") {
  if (!schema || typeof schema !== "object") return "undefined";
  if (schema.default !== undefined) return JSON.stringify(schema.default);
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return JSON.stringify(schema.examples[0]);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return JSON.stringify(schema.enum[0]);

  switch (schema.type) {
    case "string":
      return JSON.stringify(exampleString(name, schema));
    case "number":
    case "integer":
      return String(schema.minimum ?? 0);
    case "boolean":
      return "false";
    case "array":
      return `[${exampleForSchema(schema.items ?? {}, singularize(name))}]`;
    case "object": {
      const childSchema = normalizeObjectSchema(schema);
      const required = new Set(childSchema.required ?? []);
      const entries = Object.entries(childSchema.properties ?? {}).filter(([key]) => required.has(key));
      return `{ ${entries.map(([key, value]) => `${key}: ${exampleForSchema(value, key)}`).join(", ")} }`;
    }
    default:
      if (schema.properties) return exampleForSchema({ ...schema, type: "object" }, name);
      if (schema.items) return `[${exampleForSchema(schema.items, singularize(name))}]`;
      return "undefined";
  }
}

function exampleString(name, schema) {
  if (schema.format === "uri" || schema.format === "url" || /url|uri|href/i.test(name)) return "https://example.com";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  if (/function|script|code/i.test(name)) return "() => null";
  if (/path|file/i.test(name)) return "/path/to/file";
  if (/id|uid/i.test(name)) return "id";
  if (/query|search/i.test(name)) return "search terms";
  if (/text|message|content/i.test(name)) return "text";
  return "value";
}

function singularize(name) {
  return String(name).replace(/s$/, "") || "item";
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function shortText(text, maxLength) {
  const value = oneLine(text);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function tokenize(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_$.-]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
}

function summarizeSchemaForSearch(schema) {
  if (!schema || typeof schema !== "object") return "";
  return [
    schema.title,
    schema.description,
    ...getSchemaKeys(schema)
  ].filter(Boolean).join(" ");
}

function getSchemaKeys(schema) {
  if (!schema || typeof schema !== "object") return [];
  const keys = new Set();
  for (const key of Object.keys(schema.properties ?? {})) keys.add(key);
  for (const key of schema.required ?? []) keys.add(key);
  return [...keys];
}

function safeArtifactName(name) {
  const normalized = String(name || "artifact.txt").replace(/[\\/]/g, "_");
  return normalized.replace(/^\.+/, "") || "artifact.txt";
}

function inferArtifactFormat(name, value) {
  if (/\.json$/i.test(name)) return "json";
  if (typeof value === "string") return "text";
  return "json";
}

function formatArtifact(value, format) {
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  if (typeof value === "string") return value;
  return util.inspect(value, {
    depth: 12,
    colors: false,
    maxArrayLength: 1000
  });
}

function compactValue(value, options = {}) {
  const maxArray = Math.max(0, Number(options.maxArray ?? 20));
  const maxString = Math.max(0, Number(options.maxString ?? 500));
  const maxDepth = Math.max(0, Number(options.maxDepth ?? 8));
  return compactVisit(value, { maxArray, maxString, maxDepth }, 0, new WeakSet());
}

function compactVisit(value, limits, depth, seen) {
  if (typeof value === "string") {
    return value.length > limits.maxString
      ? `${value.slice(0, limits.maxString).trimEnd()}...`
      : value;
  }
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= limits.maxDepth) return summarizeValue(value);

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.maxArray).map((item) => compactVisit(item, limits, depth + 1, seen));
    if (value.length > limits.maxArray) {
      items.push({ truncatedItems: value.length - limits.maxArray });
    }
    seen.delete(value);
    return items;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = compactVisit(item, limits, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function summarizeValue(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, 20) };
  }
  return { type: typeof value };
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
