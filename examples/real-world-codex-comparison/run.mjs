#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const experimentDir = path.join(rootDir, "examples", "real-world-codex-comparison");
const outDir = path.join(rootDir, ".tmp", "real-world-codex-comparison", timestamp());
const codexHomeRoot = path.join(outDir, "codex-home");
const hostCodexHome = path.join(process.env.HOME ?? "", ".codex");
const model = process.env.CODEX_MODEL || undefined;
const maxCodexAttempts = Number.parseInt(process.env.CODEX_ATTEMPTS ?? "3", 10);
const retryDelayMs = Number.parseInt(process.env.CODEX_RETRY_DELAY_MS ?? "30000", 10);
const humanCodexOutput = process.env.CODEX_HUMAN_OUTPUT === "1";
const promptTemplate = await fs.readFile(path.join(experimentDir, "prompt.txt"), "utf8");
const scriptedProgram = await fs.readFile(path.join(experimentDir, "scripted-repl-task.js"), "utf8");

const visibleChromeConfig = process.env.REAL_WORLD_CHROME_CONFIG
  ? path.resolve(process.env.REAL_WORLD_CHROME_CONFIG)
  : path.join(rootDir, "examples", "chrome-devtools-visible.json");
const replArtifactDir = path.join(outDir, "mcp2repl-artifacts");
const nativeMcpConfig = process.env.MCP2REPL_CONFIG
  ? path.resolve(process.env.MCP2REPL_CONFIG)
  : visibleChromeConfig;
const nativeMcpServer = process.env.MCP2REPL_SERVER ?? "chrome-devtools";
const chromeArgs = process.env.REAL_WORLD_CHROME_BROWSER_URL
  ? [
      "-y",
      "chrome-devtools-mcp@latest",
      `--browserUrl=${process.env.REAL_WORLD_CHROME_BROWSER_URL}`,
      "--no-usage-statistics",
      "--no-performance-crux"
    ]
  : [
      "-y",
      "chrome-devtools-mcp@latest",
      "--isolated",
      "--viewport=1440x1000",
      "--no-usage-statistics",
      "--no-performance-crux",
      "--chrome-arg=--lang=en-US",
      "--chrome-arg=--accept-lang=en-US,en",
      "--chrome-arg=--disable-features=Translate"
    ];
let nativeReplLibrary = "";

await fs.mkdir(outDir, { recursive: true });
const scriptedPath = path.join(outDir, "scripted-repl-task.js");
await fs.writeFile(scriptedPath, scriptedProgram);

const variantFilter = new Set(
  String(process.env.CODEX_VARIANTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const allVariants = [
  {
    name: "pure-mcp",
    mode: "mcp",
    skillInstalled: false,
    codexMcpInjected: true,
    config: [
      "mcp_servers.chrome-devtools.command=\"npx\"",
      `mcp_servers.chrome-devtools.args=${tomlStringArray(chromeArgs)}`
    ]
  },
  {
    name: "interactive-repl",
    mode: "repl",
    skillInstalled: true,
    codexMcpInjected: false,
    config: []
  },
  {
    name: "scripted-repl",
    mode: "scripted",
    skillInstalled: true,
    codexMcpInjected: false,
    config: []
  },
  {
    name: "native-repl",
    mode: "native",
    skillInstalled: false,
    codexMcpInjected: false,
    config: []
  }
];
const variants = variantFilter.size > 0
  ? allVariants.filter((variant) => variantFilter.has(variant.name))
  : allVariants;

if (variants.length === 0) {
  throw new Error(`CODEX_VARIANTS did not match any variants: ${[...variantFilter].join(", ")}`);
}
if (variants.some((variant) => variant.mode === "native")) {
  nativeReplLibrary = await buildNativeReplLibrary();
}

const summaries = [];
for (const variant of variants) {
  console.error(`\n=== Running ${variant.name} ===`);
  variant.codexHome = await prepareCodexHome(variant);
  const prompt = renderPrompt(variant.mode);
  await fs.writeFile(path.join(outDir, `${variant.name}.prompt.txt`), prompt);
  await fs.writeFile(
    path.join(outDir, `${variant.name}.environment.json`),
    `${JSON.stringify({
      codexHome: variant.codexHome,
      skillInstalled: variant.skillInstalled,
      codexMcpInjected: variant.codexMcpInjected,
      ignoredUserConfig: true
    }, null, 2)}\n`
  );
  const jsonlPath = path.join(outDir, `${variant.name}.jsonl`);
  const resultPath = path.join(outDir, `${variant.name}.result.txt`);
  const summary = await runCodexVariant(variant, prompt, jsonlPath, resultPath);
  summaries.push(summary);
  console.error(`${variant.name}: ${summary.usage.total_tokens} total tokens`);
}

const markdown = renderMarkdown(summaries);
await fs.writeFile(path.join(outDir, "summary.md"), markdown);
console.log(markdown);
console.error(`\nArtifacts written to ${outDir}`);

function renderPrompt(mode) {
  const modeInstructions = {
    mcp: [
      "Use only the available Chrome/browser MCP automation tools.",
      "Do not use shell commands, filesystem commands, direct HTTP clients, or external scrapers.",
      "Drive the browser manually through top-level MCP tool calls.",
      "Avoid take_snapshot on full Apple pages unless absolutely necessary.",
      "Use evaluate_script to return compact structured fields instead of long page text."
    ].join(" "),
    repl: [
      "Use the installed mcp2repl skill to discover the local REPL workflow.",
      "Codex has no browser MCP tools in this run; use shell only to run the local mcp2repl CLI against Chrome MCP.",
      "Root constraint: do not drive the task as many shell turns. Avoid repeatedly carrying code or observations in the Codex transcript.",
      "Isolation constraint: do not read, copy, grep, inspect, or derive from examples/real-world-codex-comparison/scripted-repl-task.js, native outputs, previous experiment artifacts, or any prewritten Apple task implementation. Build the harness from the task prompt, the skill quick start, and runtime tool discovery only.",
      "Use mcp2repl as an interactive evaluator: create one JavaScript harness file that loads functions onto globalThis, then use one multi-line -e program to load the harness, call probe, call final, and stop if needed. This simulates MCP-style tool calls, but the loops, retries, DOM inspection, extraction, and compression run inside the evaluator.",
      "Do not manually start a session daemon. The first session client call auto-starts it when --config is present.",
      "The runner sets MCP2REPL_* environment defaults for config, server, session, json, timeout, max output, and artifact directory. Use short commands only.",
      "The multi-line -e program should use await api.load(<harness-file>) inside the persistent session, then call functions such as globalThis.appleTask.probe(args) and globalThis.appleTask.final(args).",
      "Do not run separate load/probe/final/stop shell commands unless the multi-line -e command fails and needs one focused repair. The purpose of interactive REPL here is to keep model-facing control compact while evaluator-side code performs the browser loops.",
      "Do not use inline --eval browser programs. Do not paste browser JavaScript into shell commands after the harness is loaded.",
      "Hard interaction budget: read at most the first 110 lines of the skill, write one harness file, run one multi-line -e command. If it fails syntax/runtime validation, make at most one focused patch and rerun one multi-line -e command.",
      "The harness itself must not assume a fixed Apple DOM. It must probe page text and controls internally, select compare-page options when useful, extract compact evidence, and return compact checkpoints/final JSON. Wrap uncertain tool outputs with api.unwrap(...).",
      "For page JavaScript, use api.evalTool('evaluate_script', (args) => { ... }, args) instead of calling tools.evaluate_script directly. Do not pass an args key to Chrome evaluate_script; api.evalTool embeds arguments into the function source and sends only schema-valid MCP arguments.",
      "Before visiting product pages, open https://www.apple.com/ in the evaluator and set a US English Apple session cookie/localStorage. If any Apple URL lands on /choose-country-region/, the harness must recover inside final() by selecting United States or resetting the US session and renavigating; do not treat the country chooser as product evidence.",
      "Apple shop prices often appear as strings like 'From $1099 or $91.58/mo.' or '13-inch ... From $1099 ...'. Extract the first From/Starting-at dollar amount as the product price. Do not discard a line merely because it also contains /mo or monthly installment text; just ignore the smaller monthly amount.",
      "For configurator-style pages, do not rely only on document.body.innerText. Extract a compact text corpus from visible body text plus labels, buttons, inputs, option values, aria-labels, selected controls, and nearby parent text. Product size and price may be split across controls rather than one body line.",
      "For this Apple task, price extraction must be size-specific from the public buy pages, not from compare placeholders or education promos: on the MacBook Air buy page extract the line/window matching 13-inch for the 13-inch Air price and the line/window matching 15-inch for the 15-inch Air price; on the MacBook Pro buy page extract the line/window matching 14-inch for the 14-inch Pro price. Ignore values from 'education savings', trade-in, AppleCare, delivery fees, and compare-page placeholders such as '$price.display.smart' or very small app/service prices.",
      "A reliable Apple extraction strategy is line-based: preserve document.body.innerText newlines, then on buy pages find the size label line ('13-inch', '15-inch', '14-inch') and read the nearest following 'From $...' line. For Air memory/storage, the public buy page exposes lines like 'Available in 16GB, 24GB, or 32GB' and 'Available in 512GB to 4TB'; these can support both Air sizes. For Pro, use the Pro buy page plus compare/product page rows; do not use Air rows for Pro.",
      "The scenarios require at least 16GB memory and at least 512GB storage. A higher visible option satisfies the requirement: 'Available in 24GB...' satisfies at least 16GB, and 'Available in 1TB to 8TB' satisfies at least 512GB. Do not mark storage unknown merely because the visible Pro range starts at 1TB.",
      "Validate product separation inside final(): 13-inch Air and 15-inch Air must not have the same size-specific price unless the page genuinely shows the same size-specific price; Pro must not inherit Air display, Air weight, or Air evidence. If validation fails, run targeted evaluator-side extraction before returning.",
      "Do not use shell commands such as jq/cat/sed to inspect mcp2repl artifacts after browser work starts. Artifacts are evaluator-side memory, not model-facing diagnostics.",
      "Implement final() so it validates every required field. If any scenario is missing price, chip, memory, storage, or two evidence facts, final() must run targeted evaluator-side extraction before returning; it must not return invariantPassed:false as the final answer unless Apple pages are inaccessible or Apple no longer exposes a public field.",
      "For this Apple task, final() should use the compare page structurally: select or read the columns for MacBook Air 13-in. (M5), MacBook Air 15-in. (M5), and MacBook Pro 14-in. (M5), then extract rows such as Display, Chip, Memory, Storage, Weight, Power and Battery, and Ports from row children. Use those row cells to fill Pro memory/storage instead of relying only on broad page text.",
      "Large observations must be saved with api.saveArtifact() and summarized, not printed.",
      "Do not hard-code prices, chip names, memory, storage, or evidence. Every non-unknown fact must come from a probe result returned by mcp2repl in this run.",
      "Do not print full arrays of labels, controls, snippets, page text, screenshots, or snapshots. Save raw compact evidence with api.saveArtifact() if needed, and return only final JSON.",
      "Create temporary JavaScript files under `.tmp/real-world-codex-comparison/`.",
      "Do not use curl, wget, Python requests, browserless scraping, or direct network fetches outside Chrome MCP."
    ].join(" "),
    scripted: [
      "Use shell only to run this exact prewritten mcp2repl program:",
      `node ./src/cli.js --config ${visibleChromeConfig} --server chrome-devtools --timeout 240 --file ${scriptedPath}`,
      "Do not edit the program. Do not use curl, wget, Python requests, browserless scraping, or direct network fetches outside Chrome MCP.",
      "When the command finishes, return the exact JSON object printed by the command as your entire final answer.",
      "Do not rewrite, normalize, summarize, validate, repair, or replace any field from that JSON."
    ].join(" "),
    native: [
      "You are writing code for a native mcp2repl eval surface.",
      "Do not use shell commands, filesystem commands, or Codex MCP tools.",
      "Return only a JavaScript program, with no markdown fences and no explanation.",
      "The top-level program must explicitly return the final compact JSON object or JSON string; do not leave the final value as a bare expression statement.",
      "The runner will execute your JavaScript with mcp2repl against Chrome MCP after this turn.",
      "Before researching Apple pages, set a US English Apple session if needed: open https://www.apple.com/, set document.cookie to geo=US for .apple.com, then use the URLs from the task, including /us/shop URLs for shopping pages.",
      "Your program must validate its own result and set invariantPassed to false if any option has unknown price, unknown chip, fewer than two evidence facts, or missing memory/storage.",
      "When extracting prices, match dollar amounts anywhere inside strings such as 'From $1099 or $91.58/mo.'; do not require the string to start with '$'.",
      "For this MacBook task, laptop prices are above $900. Ignore delivery fees, subscriptions, monthly installments, AppleCare, app prices, and other small dollar amounts.",
      "For the three required scenarios, prefer prices near the matching labels: 13-inch Air, 15-inch Air, and 14-inch Pro.",
      "Do not default chip names. Extract visible M-series chip names from the page; use unknown if not visible.",
      "Do not hard-code fallback facts, prices, chip names, memory, or storage values. Values such as M4, M5, $1199, $1399, or $1599 are invalid unless extracted from page text in the same run.",
      "Do not use one broad page-wide text blob as the source for all three products. Extract product-specific cards, table columns, or nearby DOM text for each scenario.",
      "However, Apple often splits a product's price, chip, memory, storage, display, and size into different sections. First run a coarse page probe with document.body.innerText length, first sample, prices, and headings; then combine body text, compare text, and shop controls. Do not require every fact to live in one DOM card.",
      "For shared Air facts on the MacBook Air page, it is valid to use the same visible page fact for both 13-inch and 15-inch Air, while size/display/price should still be tied to the matching scenario when visible.",
      "A result is invalid if the same price is used for all three scenarios, if evidence arrays are empty, or if memory/storage remain unknown.",
      "If a shop configurator is hard to click, use the compare page and product pages to extract the visible 16GB/512GB facts, but keep each fact tied to the matching product label.",
      "Before returning, run a local validation loop over the JSON object. If validation fails, perform more targeted extraction instead of returning a failed object.",
      "The tool docs below were generated from the MCP server schema by mcp2repl at runtime; do not assume they are Chrome-specific outside this experiment.",
      nativeReplLibrary
    ].join(" ")
  }[mode];

  return promptTemplate.replace("REAL_WORLD_MODE_INSTRUCTIONS", modeInstructions);
}

async function prepareCodexHome(variant) {
  const home = path.join(codexHomeRoot, variant.name);
  await fs.mkdir(home, { recursive: true });

  await copyIfExists(path.join(hostCodexHome, "auth.json"), path.join(home, "auth.json"));
  await copyIfExists(path.join(hostCodexHome, "installation_id"), path.join(home, "installation_id"));

  if (variant.skillInstalled) {
    await fs.mkdir(path.join(home, "skills"), { recursive: true });
    await fs.cp(
      path.join(rootDir, "skills", "mcp2repl"),
      path.join(home, "skills", "mcp2repl"),
      { recursive: true }
    );
  }

  return home;
}

async function copyIfExists(source, destination) {
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function runCodexVariant(variant, prompt, jsonlPath, resultPath) {
  let lastFailure;
  let currentPrompt = prompt;
  let combinedJsonl = "";
  for (let attempt = 1; attempt <= maxCodexAttempts; attempt += 1) {
    const attemptJsonlPath = attempt === maxCodexAttempts
      ? jsonlPath
      : withAttemptSuffix(jsonlPath, attempt);
    const attemptResultPath = attempt === maxCodexAttempts
      ? resultPath
      : withAttemptSuffix(resultPath, attempt);
    const result = await runCodexAttempt(variant, currentPrompt, attemptJsonlPath, attemptResultPath);
    combinedJsonl += result.jsonl.endsWith("\n") ? result.jsonl : `${result.jsonl}\n`;

    if (result.code === 0) {
      if (variant.mode === "native") {
        const generatedCode = await readOptional(attemptResultPath);
        const finalText = await runNativeReplResult(variant, generatedCode, attemptResultPath, attempt);
        const passed = nativeResultPassed(finalText);
        if (passed || attempt >= maxCodexAttempts) {
          const summarizedText = passed ? finalText : markNativeRejected(finalText);
          await fs.writeFile(attemptResultPath, summarizedText);
          await fs.writeFile(jsonlPath, combinedJsonl);
          if (attemptResultPath !== resultPath) await fs.copyFile(attemptResultPath, resultPath);
          return summarizeRun(variant.name, combinedJsonl, summarizedText);
        }
        console.error(`${variant.name}: generated program failed validation on attempt ${attempt}/${maxCodexAttempts}; retrying with REPL error feedback`);
        currentPrompt = renderNativeRepairPrompt(prompt, generatedCode, finalText);
        continue;
      }
      if (attemptJsonlPath !== jsonlPath) await fs.copyFile(attemptJsonlPath, jsonlPath);
      if (attemptResultPath !== resultPath) await copyIfExists(attemptResultPath, resultPath);
      return summarizeRun(variant.name, result.jsonl, await readOptional(attemptResultPath));
    }

    lastFailure = result;
    const retryable = isRetryableCodexFailure(result.jsonl);
    if (!retryable || attempt >= maxCodexAttempts) break;

    console.error(
      `${variant.name}: retryable Codex capacity failure on attempt ${attempt}/${maxCodexAttempts}; retrying in ${retryDelayMs}ms`
    );
    await delay(retryDelayMs);
  }

  throw new Error(`codex exec failed for ${variant.name} with exit code ${lastFailure?.code ?? "unknown"}`);
}

async function runNativeReplResult(variant, codeText, resultPath, attempt = 1) {
  const code = stripMarkdownCode(codeText);
  const programPath = path.join(outDir, `${variant.name}.attempt-${attempt}.generated.js`);
  const replOutputPath = path.join(outDir, `${variant.name}.attempt-${attempt}.repl-output.json`);
  await fs.writeFile(programPath, code);

  const child = spawn("node", [
    "./src/cli.js",
    "--quiet",
    "--json",
    "--max-output-chars",
    "12000",
    "--config",
    nativeMcpConfig,
    "--server",
    nativeMcpServer,
    "--timeout",
    "240",
    "--file",
    programPath
  ], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const codeResult = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  await fs.writeFile(replOutputPath, stdout);
  if (codeResult !== 0) {
    const failure = JSON.stringify({
      invariantPassed: false,
      error: stderr.trim() || stdout.trim(),
      generatedProgram: programPath
    });
    await fs.writeFile(resultPath, failure);
    return failure;
  }

  const envelope = parseFinalJson(stdout);
  const finalText = JSON.stringify(envelope?.result ?? envelope ?? { invariantPassed: false, raw: stdout.trim() });
  await fs.writeFile(resultPath, finalText);
  return finalText;
}

function nativeResultPassed(finalText) {
  const parsed = parseFinalJson(finalText);
  return parsed?.invariantPassed === true && nativeEvidenceLooksExtracted(parsed);
}

function nativeEvidenceLooksExtracted(parsed) {
  const options = parsed?.options;
  if (!Array.isArray(options) || options.length < 3) return false;
  const hardCodedFallbackPrices = new Set(["$1,199", "$1199", "$1,399", "$1399", "$1,599", "$1599"]);
  for (const option of options) {
    const evidence = Array.isArray(option.evidence) ? option.evidence : [];
    const evidenceText = evidence.join(" ");
    const hasPageLikeEvidence = evidence.some((item) => String(item).length >= 18 && /MacBook|display|battery|Thunderbolt|MagSafe|HDMI|SDXC|storage|memory|From \$|\$[0-9]/i.test(item));
    if (!hasPageLikeEvidence) return false;
    if (hardCodedFallbackPrices.has(option.configuredOrRelevantPrice) && !/\$[0-9]/.test(evidenceText)) return false;
  }
  return true;
}

function markNativeRejected(finalText) {
  const parsed = parseFinalJson(finalText) ?? { raw: finalText };
  return JSON.stringify({
    ...parsed,
    invariantPassed: false,
    nativeReplExternalValidation: "failed: result used generic fallback evidence or did not prove page-extracted facts"
  });
}

function renderNativeRepairPrompt(originalPrompt, generatedCode, finalText) {
  return [
    originalPrompt,
    "",
    "The previous JavaScript program failed when executed by the generic mcp2repl REPL.",
    "Return a complete corrected JavaScript program only. Do not include markdown or explanation.",
    "The top-level program must explicitly return the final compact JSON object or JSON string.",
    "Keep the same public Apple task and the same no-login/no-cart/no-checkout constraints.",
    "Prefer simpler syntax over clever regular expressions. Any regex literal containing a slash must escape it correctly, or use RegExp strings.",
    "Do not reuse one broad page-wide text blob for all products. Extract product-specific cards, table columns, or nearby DOM text for each scenario.",
    "But do not over-filter. Apple pages split facts across body text, compare tables, and shop controls; use coarse document.body.innerText probes before writing selectors.",
    "The output must pass invariantPassed true. If fields are unknown, change the extraction strategy instead of returning a failed object.",
    "Do not add hard-coded fallback facts, prices, chip names, memory, or storage. The runner rejects generic fallback evidence.",
    "Previous failure/result:",
    "```json",
    shortForPrompt(finalText, 5000),
    "```",
    "Previous program:",
    "```js",
    shortForPrompt(generatedCode, 16000),
    "```"
  ].join("\n");
}

function shortForPrompt(text, maxLength) {
  const value = String(text ?? "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...<truncated ${value.length - maxLength} chars>`;
}

async function buildNativeReplLibrary() {
  if (process.env.NATIVE_REPL_LIBRARY_FILE) {
    return fs.readFile(process.env.NATIVE_REPL_LIBRARY_FILE, "utf8");
  }

  const query = process.env.NATIVE_REPL_QUERY ?? "navigate evaluate wait page click";
  const limit = process.env.NATIVE_REPL_LIMIT ?? "6";
  const result = await runLocalMcp2repl([
    "--quiet",
    "--json",
    "--config",
    nativeMcpConfig,
    "--server",
    nativeMcpServer,
    "--library",
    query,
    "--limit",
    limit
  ]);
  const envelope = parseFinalJson(result.stdout);
  if (result.code !== 0 || !envelope?.ok) {
    throw new Error([
      "Failed to generate native REPL library docs from MCP schema.",
      result.stderr.trim(),
      result.stdout.trim()
    ].filter(Boolean).join("\n"));
  }
  return [
    "Available generated mcp2repl library functions:",
    ...(envelope.result ?? [])
  ].join("\n\n");
}

async function runLocalMcp2repl(args) {
  const child = spawn("node", ["./src/cli.js", ...args], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  return { code, stdout, stderr };
}

function stripMarkdownCode(text) {
  const value = String(text ?? "").trim();
  const fenced = value.match(/^```(?:js|javascript)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

async function runCodexAttempt(variant, prompt, jsonlPath, resultPath) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--cd",
    rootDir,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    resultPath
  ];
  if (!humanCodexOutput) args.splice(1, 0, "--json");
  else args.splice(1, 0, "--color", "always");

  if (model) args.push("--model", model);
  for (const override of variant.config) {
    args.push("-c", override);
  }
  args.push(prompt);

  const child = spawn("codex", args, {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEX_HOME: variant.codexHome,
      ...(variant.mode === "repl" ? {
        MCP2REPL_CONFIG: visibleChromeConfig,
        MCP2REPL_SERVER: "chrome-devtools",
        MCP2REPL_SESSION: "apple",
        MCP2REPL_ARTIFACT_DIR: replArtifactDir,
        MCP2REPL_TIMEOUT: "240",
        MCP2REPL_MAX_OUTPUT_CHARS: process.env.MCP2REPL_MAX_OUTPUT_CHARS ?? "6000",
        MCP2REPL_JSON: "1",
        MCP2REPL_QUIET: "1"
      } : {})
    },
    stdio: ["ignore", "pipe", "inherit"]
  });

  let jsonl = "";
  child.stdout.on("data", (chunk) => {
    process.stderr.write(chunk);
    jsonl += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await fs.writeFile(jsonlPath, jsonl);

  return { code, jsonl };
}

function summarizeRun(name, jsonl, finalText) {
  const events = jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
  const itemTypes = {};
  let failedItems = 0;

  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) {
      usage.input_tokens += event.usage.input_tokens ?? 0;
      usage.cached_input_tokens += event.usage.cached_input_tokens ?? 0;
      usage.output_tokens += event.usage.output_tokens ?? 0;
      usage.reasoning_output_tokens += event.usage.reasoning_output_tokens ?? 0;
    }
    if (event.type === "item.completed" && event.item?.type) {
      itemTypes[event.item.type] = (itemTypes[event.item.type] ?? 0) + 1;
      if (event.item.status === "failed" || event.item.error) failedItems += 1;
    }
  }
  usage.total_tokens = usage.input_tokens + usage.output_tokens;

  return {
    name,
    skillInstalled: variantByName(name)?.skillInstalled ?? false,
    codexMcpInjected: variantByName(name)?.codexMcpInjected ?? false,
    usage,
    itemTypes,
    failedItems,
    humanCodexOutput,
    finalText: finalText.trim(),
    finalJson: parseFinalJson(finalText),
    externalValidationPassed: resultLooksValid(parseFinalJson(finalText))
  };
}

function resultLooksValid(parsed) {
  if (!parsed || parsed.invariantPassed !== true) return false;
  const options = parsed.options;
  if (!Array.isArray(options) || options.length < 3) return false;

  const normalized = options.map((option) => ({
    option,
    text: JSON.stringify(option).toLowerCase(),
    identityText: [
      option.productName,
      option.scenario,
      option.display
    ].map((value) => String(value ?? "")).join(" ").toLowerCase(),
    price: parseDollar(option.configuredOrRelevantPrice) ?? parseDollar(option.visibleStartingPrice)
  }));

  const air13 = normalized.find(({ identityText }) => /13[^a-z0-9]*inch.*macbook air|macbook air.*13[^a-z0-9]*inch/.test(identityText));
  const air15 = normalized.find(({ identityText }) => /15[^a-z0-9]*inch.*macbook air|macbook air.*15[^a-z0-9]*inch/.test(identityText));
  const pro14 = normalized.find(({ identityText }) => /14[^a-z0-9]*inch.*macbook pro|macbook pro.*14[^a-z0-9]*inch/.test(identityText));
  if (!air13 || !air15 || !pro14) return false;

  for (const { option, price } of normalized) {
    const evidence = Array.isArray(option.evidence) ? option.evidence : [];
    if (!price || price < 900) return false;
    for (const key of ["productName", "officialUrl", "chip", "memory", "storage"]) {
      if (isUnknown(option[key])) return false;
    }
    if (evidence.length < 2) return false;
    if (!evidence.some((item) => /macbook|m[0-9]|memory|storage|display|battery|thunderbolt|magsafe|from \$|\$[0-9]/i.test(String(item)))) return false;
  }

  if (air13.price && air15.price && air13.price === air15.price) return false;
  if (/macbook air/.test(pro14.text) && !/macbook pro/.test(pro14.text)) return false;
  return true;
}

function isUnknown(value) {
  return value == null || String(value).trim() === "" || /^unknown$/i.test(String(value).trim());
}

function parseDollar(value) {
  const match = String(value ?? "").match(/\$([0-9][0-9,]*(?:\.\d{2})?)/);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

function renderMarkdown(summaries) {
  const baseline = summaries.find((summary) => summary.name === "pure-mcp");
  const lines = [
    "# Real-World Codex Comparison: Chrome MCP vs mcp2repl CLI",
    "",
    `Model: ${model ?? "Codex default"}`,
    "",
    "| Variant | Skill | Codex MCP | Input | Cached input | Uncached input | Output | Reasoning output | Total | Uncached total | Invariant passed | Failed items | Item types |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |"
  ];

  for (const summary of summaries) {
    const uncachedInput = Math.max(0, summary.usage.input_tokens - summary.usage.cached_input_tokens);
    const uncachedTotal = uncachedInput + summary.usage.output_tokens;
    lines.push(`| ${summary.name} | ${summary.skillInstalled ? "yes" : "no"} | ${summary.codexMcpInjected ? "yes" : "no"} | ${summary.usage.input_tokens} | ${summary.usage.cached_input_tokens} | ${uncachedInput} | ${summary.usage.output_tokens} | ${summary.usage.reasoning_output_tokens} | ${summary.usage.total_tokens} | ${uncachedTotal} | ${summary.externalValidationPassed ? "true" : "false"} | ${summary.failedItems} | ${inlineCode(JSON.stringify(summary.itemTypes))} |`);
  }

  if (baseline) {
    lines.push("");
    for (const summary of summaries.filter((item) => item !== baseline)) {
      const saved = baseline.usage.total_tokens - summary.usage.total_tokens;
      const deltaLabel = saved >= 0 ? `${saved} fewer tokens` : `${Math.abs(saved)} more tokens`;
      const percent = baseline.usage.total_tokens > 0
        ? Math.abs((saved / baseline.usage.total_tokens) * 100).toFixed(1)
        : "0.0";
      const efficiency = summary.usage.total_tokens > 0
        ? (baseline.usage.total_tokens / summary.usage.total_tokens).toFixed(2)
        : "0.00";
      const direction = saved >= 0 ? "reduction" : "increase";
      lines.push(`${summary.name} delta vs pure-mcp: ${deltaLabel} (${percent}% ${direction}, ${efficiency}x baseline/variant ratio).`);
    }
  }

  lines.push("");
  lines.push("## Final Answers");
  for (const summary of summaries) {
    lines.push("");
    lines.push(`### ${summary.name}`);
    lines.push("```json");
    lines.push(summary.finalText);
    lines.push("```");
  }

  return `${lines.join("\n")}\n`;
}

function parseFinalJson(text) {
  const unwrapParsed = (value) => {
    if (typeof value !== "string") return value;
    const nested = parseFinalJson(value);
    return nested ?? value;
  };
  try {
    return unwrapParsed(JSON.parse(text.trim()));
  } catch {}
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return unwrapParsed(JSON.parse(fenced[1]));
    } catch {}
  }
  const object = text.match(/\{[\s\S]*\}/);
  if (object) {
    try {
      return unwrapParsed(JSON.parse(object[0]));
    } catch {}
  }
  return null;
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function tomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function variantByName(name) {
  return allVariants.find((variant) => variant.name === name);
}

function isRetryableCodexFailure(jsonl) {
  return /Selected model is at capacity|temporarily unavailable|overloaded|try again/i.test(jsonl);
}

function withAttemptSuffix(filePath, attempt) {
  const extension = path.extname(filePath);
  const base = filePath.slice(0, -extension.length);
  return `${base}.attempt-${attempt}${extension}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
