import vm from "node:vm";
import util from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createToolFacade } from "./mcp-client.js";

const PRINT_ENVELOPE = Symbol.for("mcp2repl.printEnvelope");

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
      project: (value, projection = true, options = {}) => projectValue(value, projection, options),
      print: (value, options = {}) => this.#printValue(value, options),
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
    const before = snapshotGlobalRefs(this.context);
    await this.eval([
      "return await (async () => {",
      code,
      "\nreturn true;",
      "})()"
    ].join("\n"));
    const manifest = moduleManifest(this.context, before);
    return {
      loaded: resolved,
      digest: `sha256:${createHash("sha256").update(code).digest("hex")}`,
      exports: manifest.exports,
      topLevel: manifest.topLevel
    };
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
    const handle = {
      name: safeName,
      kind: "evaluator-memory",
      bytes: Buffer.byteLength(data),
      format,
      readWith: `await api.readArtifact(${JSON.stringify(safeName)})`
    };
    if (options.path === true || options.exposePath === true || process.env.MCP2REPL_ARTIFACT_PATHS === "1") {
      handle.path = filePath;
    }
    return handle;
  }

  async #readArtifact(name) {
    const safeName = safeArtifactName(typeof name === "object" && name ? name.name : name);
    const filePath = path.join(this.artifactDir, safeName);
    const text = await fs.readFile(filePath, "utf8");
    const parsed = parseJsonLike(text);
    return parsed.parsed ? parsed.value : text;
  }

  async #printValue(value, options = {}) {
    const projection = Object.prototype.hasOwnProperty.call(options, "projection")
      ? options.projection
      : options.project;
    const projected = projection == null
      ? compactValue(value, options)
      : projectValue(value, projection, options);
    const maxChars = Number(options.maxChars ?? options.maxOutputChars ?? this.options.maxOutputChars ?? 0);
    const text = jsonText(projected);
    if (maxChars > 0 && text.length > maxChars) {
      const originalLargeFields = findLargeFields(projected, { limit: 8 });
      const fitted = options.fit === false
        ? null
        : await this.#fitPrintedValue(projected, { ...options, maxChars, originalLargeFields });
      if (fitted) return printEnvelope(fitted);

      return printEnvelope(await this.#tooLargeEnvelope(projected, {
        maxOutputChars: maxChars,
        artifactName: options.artifactName ?? "printed-result.json"
      }));
    }
    return printEnvelope({
      ok: true,
      result: projected
    });
  }

  async #fitPrintedValue(value, options = {}) {
    const maxChars = Number(options.maxChars ?? 0);
    if (maxChars <= 0) return null;
    const attempts = compactFitAttempts(options);
    for (const limits of attempts) {
      const candidate = compactValue(value, limits);
      const candidateText = jsonText(candidate);
      if (candidateText.length <= maxChars) {
        const saved = await this.#saveArtifact(options.artifactName ?? "printed-result.json", value, { format: "json" });
        return {
          ok: true,
          result: candidate,
          printer: {
            compacted: true,
            originalChars: jsonText(value).length,
            printedChars: candidateText.length,
            maxChars,
            limits,
            artifact: saved,
            note: "The evaluator printer shortened the model-facing representation. The full value remains in evaluator memory."
          },
          ...(options.diagnostics === true
            ? { diagnostics: { largeFields: options.originalLargeFields ?? findLargeFields(value, { limit: 8 }) } }
            : {})
        };
      }
    }
    return null;
  }

  async #responseEnvelope(value, options = {}) {
    if (isPrintEnvelope(value)) return unmarkPrintEnvelope(value);

    const text = jsonText(value);
    const maxOutputChars = Number(options.maxOutputChars ?? 0);
    if (maxOutputChars > 0 && text.length > maxOutputChars) {
      return await this.#tooLargeEnvelope(value, {
        maxOutputChars,
        artifactName: "result.json"
      });
    }

    return {
      ok: true,
      result: value
    };
  }

  async #tooLargeEnvelope(value, options = {}) {
    const saved = await this.#saveArtifact(options.artifactName ?? "result.json", value, { format: "json" });
    const actualChars = jsonText(value).length;
    const maxOutputChars = Number(options.maxOutputChars ?? 0);
    return {
      ok: false,
      error: "ResultTooLarge",
      message: `Evaluator result is ${actualChars} JSON characters, above the ${maxOutputChars} character limit.`,
      artifact: saved,
      truncated: true,
      summary: summarizeValue(value),
      largeFields: findLargeFields(value, { limit: 8 }),
      repair: {
        strategy: "repair-procedure-or-projection",
        hint: "Shorten the compound procedure that produced this value, or return api.print(value, { projection, maxChars }). Keep compression inside the evaluator instead of reading the artifact from shell."
      }
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
    "  api.project(value, projection, options?) -> evaluator-side projection for compact decision views.",
    "  await api.print(value, { projection?, maxChars?, fit? }) -> model-facing print envelope; auto-fits the representation when possible and returns ResultTooLarge with largeFields when it cannot fit.",
    "  api.unwrap(value) -> normalizes common MCP/Codex/result envelopes and parses JSON strings when possible.",
    "  api.load(path) -> loads a JavaScript file into the same evaluator context and returns { loaded, digest, exports, topLevel }.",
    "- Store large intermediate data outside model context:",
    "  await api.saveArtifact('snapshot.json', value) -> evaluator-memory handle { name, kind, bytes, format, readWith }.",
    "  await api.readArtifact(handleOrName) -> reads a saved artifact back into the evaluator.",
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
    "Use api.project() or api.print() to return compact decision views.",
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
  if (format === "json") return `${jsonText(value, 2)}\n`;
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

function projectValue(value, projection = true, options = {}) {
  const limits = compactOptions(options);
  return projectVisit(value, projection, limits, new WeakSet());
}

function projectVisit(value, projection, limits, seen) {
  if (projection === true || projection == null) return compactVisit(value, limits, 0, seen);
  if (typeof projection === "string") return compactVisit(getPath(value, projection), limits, 0, seen);
  if (Array.isArray(projection)) return pickPaths(value, projection, limits);
  if (!projection || typeof projection !== "object") return compactVisit(value, limits, 0, seen);

  const nextLimits = compactOptions({
    maxArray: projection.$maxArray ?? limits.maxArray,
    maxString: projection.$maxString ?? limits.maxString,
    maxDepth: projection.$maxDepth ?? limits.maxDepth
  });

  const source = projection.$path ? getPath(value, projection.$path) : value;
  if (projection.$project) return projectVisit(source, projection.$project, nextLimits, seen);

  if (Array.isArray(source)) {
    const sliced = sliceArray(source, projection.$slice);
    const itemProjection = projection.$items ?? projection.$map ?? true;
    return sliced.map((item) => projectVisit(item, itemProjection, nextLimits, seen));
  }

  if (!source || typeof source !== "object") return compactVisit(source, nextLimits, 0, seen);

  const output = {};
  if (Array.isArray(projection.$pick)) {
    Object.assign(output, pickPaths(source, projection.$pick, nextLimits));
  }

  const omit = new Set(projection.$omit ?? []);
  for (const [key, childProjection] of Object.entries(projection)) {
    if (key.startsWith("$") || omit.has(key)) continue;
    output[key] = projectVisit(source?.[key], childProjection, nextLimits, seen);
  }

  if (Object.keys(output).length > 0) return output;
  return compactVisit(source, nextLimits, 0, seen);
}

function compactOptions(options = {}) {
  return {
    maxArray: Math.max(0, Number(options.maxArray ?? 20)),
    maxString: Math.max(0, Number(options.maxString ?? 500)),
    maxDepth: Math.max(0, Number(options.maxDepth ?? 8))
  };
}

function compactFitAttempts(options = {}) {
  const base = compactOptions(options);
  const candidates = [
    base,
    { ...base, maxString: Math.min(base.maxString, 240), maxArray: Math.min(base.maxArray, 20) },
    { ...base, maxString: Math.min(base.maxString, 160), maxArray: Math.min(base.maxArray, 16) },
    { ...base, maxString: Math.min(base.maxString, 120), maxArray: Math.min(base.maxArray, 12) },
    { ...base, maxString: Math.min(base.maxString, 80), maxArray: Math.min(base.maxArray, 10) },
    { ...base, maxString: Math.min(base.maxString, 60), maxArray: Math.min(base.maxArray, 8) },
    { ...base, maxString: Math.min(base.maxString, 40), maxArray: Math.min(base.maxArray, 6) }
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickPaths(value, paths, limits) {
  const output = {};
  for (const rawPath of paths) {
    const parts = pathParts(rawPath);
    if (parts.length === 0) continue;
    const selected = compactVisit(getByParts(value, parts), limits, 0, new WeakSet());
    setByParts(output, parts, selected);
  }
  return output;
}

function getPath(value, rawPath) {
  return getByParts(value, pathParts(rawPath));
}

function pathParts(rawPath) {
  return String(rawPath ?? "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getByParts(value, parts) {
  let current = value;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function setByParts(target, parts, value) {
  let current = target;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    current[part] ??= {};
    current = current[part];
  }
}

function sliceArray(value, slice) {
  if (slice == null) return value;
  if (Array.isArray(slice)) return value.slice(Number(slice[0] ?? 0), Number(slice[1] ?? value.length));
  return value.slice(0, Math.max(0, Number(slice)));
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

function findLargeFields(value, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 8), 50));
  const candidates = [];
  collectLargeFields(value, "", candidates, new WeakSet());
  return candidates
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit);
}

function collectLargeFields(value, currentPath, candidates, seen) {
  if (value == null) return;
  const type = Array.isArray(value) ? "array" : typeof value;
  if (currentPath) {
    candidates.push({
      path: currentPath,
      chars: jsonText(value).length,
      type,
      summary: summarizeValue(value)
    });
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLargeFields(item, `${currentPath}[${index}]`, candidates, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      collectLargeFields(item, nextPath, candidates, seen);
    }
  }
  seen.delete(value);
}

function printEnvelope(envelope) {
  Object.defineProperty(envelope, PRINT_ENVELOPE, {
    value: true,
    enumerable: false
  });
  return envelope;
}

function isPrintEnvelope(value) {
  return Boolean(value && typeof value === "object" && value[PRINT_ENVELOPE]);
}

function unmarkPrintEnvelope(value) {
  const output = { ...value };
  delete output[PRINT_ENVELOPE];
  return output;
}

function jsonText(value, space) {
  if (value === undefined) return "undefined";
  const seen = new WeakSet();
  const text = JSON.stringify(value, (key, item) => {
    if (typeof item === "bigint") return `${item}n`;
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }, space);
  return text === undefined ? JSON.stringify(String(value)) : text;
}

function snapshotGlobalRefs(context) {
  const refs = new Map();
  for (const key of Object.keys(context)) {
    refs.set(key, context[key]);
  }
  return {
    refs,
    callables: new Set(collectContextCallablePaths(context))
  };
}

function moduleManifest(context, before) {
  const changedTopLevel = Object.keys(context)
    .filter((key) => !before.refs.has(key) || before.refs.get(key) !== context[key])
    .filter((key) => !INTERNAL_GLOBALS.has(key))
    .sort();
  const allExports = collectContextCallablePaths(context);
  const exports = allExports
    .filter((item) => !before.callables.has(item) || changedTopLevel.includes(item.split(".")[0]))
    .sort();
  const topLevel = [...new Set([
    ...changedTopLevel,
    ...exports.map((item) => item.split(".")[0])
  ])].sort();
  return {
    topLevel,
    exports
  };
}

function collectContextCallablePaths(context) {
  const exports = [];
  for (const key of Object.keys(context)) {
    if (INTERNAL_GLOBALS.has(key)) continue;
    collectCallableExports(context[key], key, exports, new WeakSet(), 0);
  }
  return exports;
}

function collectCallableExports(value, prefix, exports, seen, depth) {
  if (typeof value === "function") {
    exports.push(prefix);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value) || depth >= 3) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function") exports.push(`${prefix}.${key}`);
    else if (child && typeof child === "object") collectCallableExports(child, `${prefix}.${key}`, exports, seen, depth + 1);
  }
  seen.delete(value);
}

const INTERNAL_GLOBALS = new Set([
  "console",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "Buffer",
  "process",
  "mcp",
  "api",
  "tools",
  "inspect",
  "sleep",
  "__mcp2replCall"
]);

export function repairErrorEnvelope(error) {
  const message = error?.message ?? String(error);
  const repair = error?.mcp2repl?.repairHint ?? inferRepairHint(error);
  const envelope = {
    name: error?.name ?? "Error",
    message,
    repairHint: repair
  };
  if (error?.mcp2repl) envelope.context = error.mcp2repl;
  if (error?.stack) envelope.stack = String(error.stack).split("\n").slice(0, 8).join("\n");
  return envelope;
}

function inferRepairHint(error) {
  const message = `${error?.name ?? ""} ${error?.message ?? error ?? ""}`;
  if (/SyntaxError/i.test(message)) return "Patch the loaded compound procedure syntax, then reload the task module in the same evaluator session.";
  if (/single argument object/i.test(message)) return "Call MCP primitive procedures with exactly one object argument, for example tools.some_tool({ key: value }).";
  if (/Unknown MCP tool/i.test(message)) return "Use api.searchTools() or api.listTools({ schemas: false }) to find the available primitive procedure name.";
  if (/schema|additional properties|invalid|required|enum/i.test(message)) return "Use api.describeTool() or api.library() to inspect the primitive procedure schema, then repair the argument object.";
  if (/timed out|timeout/i.test(message)) return "Split the compound procedure into smaller evaluator expressions or raise --timeout for a genuinely long operation.";
  return "Use the evaluator error and stack to make one focused repair to the corresponding compound procedure, then continue in the evaluator.";
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
