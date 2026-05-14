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
  if (process.env.REAL_WORLD_CHROME_BROWSER_URL) {
    await resetChromeForExperiment(process.env.REAL_WORLD_CHROME_BROWSER_URL);
  }
  if (variant.mode === "repl") {
    await fs.rm(path.join(rootDir, ".tmp", "real-world-codex-comparison", "apple-procedures.js"), { force: true });
  }
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
  console.error(`${variant.name}: ${summary.usage.total_tokens} total tokens, ${formatSeconds(summary.durationMs)} elapsed`);
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
      "Use the existing selected browser page and navigate it; do not create isolated contexts.",
      "Avoid take_snapshot on full Apple pages unless absolutely necessary.",
      "Use evaluate_script to return compact structured fields instead of long page text.",
      "Use the public Apple US URLs from the task. For prices, extract full upfront standard-consumer US dollar amounts such as `$1,099`; ignore monthly installments such as `$91.58/mo` and education-savings ribbon prices.",
      "Final scalar fact fields must be short facts under 120 characters. In particular, portsOrExternalDisplayNotes must be a concise port fact such as `Three Thunderbolt 4, HDMI, SDXC, MagSafe 3`; do not copy external-display paragraphs or multi-clause marketing text."
    ].join(" "),
    repl: [
      "The mcp2repl contract is summarized here; do not spend commands reading the skill, docs, source, previous artifacts, or scripted implementations unless a command fails.",
      "Codex has no browser MCP tools. Use shell only to run the local mcp2repl CLI against Chrome MCP. The runner already sets MCP2REPL_CONFIG, MCP2REPL_SERVER, MCP2REPL_SESSION, MCP2REPL_JSON, MCP2REPL_QUIET, MCP2REPL_TIMEOUT, MCP2REPL_MAX_OUTPUT_CHARS, and MCP2REPL_ARTIFACT_DIR.",
      "Use the shortest evaluator form: `node ./src/cli.js <<'JS' ... JS`. Do not repeat config/session/json/timeout flags. Start immediately with that evaluator command and avoid progress narration between successful steps.",
      "REPL philosophy: MCP tools are primitive procedures, task helpers are compound procedures, the persistent session is the evaluator environment, and artifacts are evaluator memory. Optimize for uniformly fast semantic steps: no setup-only pause, no giant final step, no one shell command per primitive call.",
      "Required sequence: (1) bootstrap a tiny environment and immediately navigate the current visible tab to https://www.apple.com/; (2) define-and-call one Air observation procedure for MacBook Air overview plus buy page; (3) define-and-call one Pro observation procedure for MacBook Pro overview plus buy/compare/spec fallback; (4) define-and-call final synthesis; at most one focused repair for a required-field failure.",
      "Step size: bootstrap should stay under 18 nonblank JS lines; later evaluator commands should target 20-45 nonblank JS lines, do 1-3 related browser primitive calls, and return one compact checkpoint. After bootstrap, do not repeat helper bodies or prior procedure bodies. If optional fields make a step long, set them to `unknown`.",
      "Bootstrap should be only this shape: define `globalThis.appleTask`, `go(url)`, `evalPage(fn,args)`, and `shortFact(text)`, then `await go('https://www.apple.com/')` and `return api.print({ step:'bootstrap', sources: appleTask.sources }, { maxChars: 1000 })`. Do not define price parsers, validators, checkpoint helpers, or product logic in bootstrap. It must already create visible browser motion.",
      "Use the existing visible Chrome tab. Do not call new_page, list_pages, or select_page unless navigate_page fails. Navigate with `mcp.call('navigate_page', { url })`; evaluate page JavaScript with `api.evalTool('evaluate_script', (args) => { ... }, args)` and wrap uncertain tool outputs with `api.unwrap(...)`.",
      "Functions passed to api.evalTool are stringified for the page. They must be self-contained; never pass `(a) => fn(a)` or close over evaluator variables.",
      "Checkpoints must be compact: `api.print({ step, invariantSoFar, missingRequired, optionsPreview, sources }, { maxChars: 3000, maxString: 120 })`. Keep raw page text, snippets, controls, and arrays in evaluator state or artifacts, not in the transcript. The final synthesis step is different: it must return the final JSON object itself with `api.print(final, { maxChars: 9000, maxString: 500 })`; do not run a separate preview/export command.",
      "Apple facts: use public US/English Apple pages only; never login, cart, checkout, personal data, curl, wget, Python requests, direct fetches, or browserless scraping. If redirected to country selection, recover in the next evaluator step by resetting/selecting United States.",
      "Prices: extract whole upfront standard-consumer laptop prices from visible text/control labels; ignore monthly `/mo`, education ribbon, trade-in, AppleCare, delivery, checkout, compare placeholders, and tiny service prices. Avoid dollar regexes and negated shell-sensitive expressions. Use a tiny scanner inside the page function: split text on `String.fromCharCode(36)`, collect leading digits/commas from each segment, keep values with at least four raw characters, reject segments whose first 48 characters include `/mo`, then prefix the dollar sign again.",
      "Fast price rule: on Air/Pro buy pages, document-order whole-dollar laptop prices are valid when size selectors are visible: first >= $1,000 for 13-inch Air, next/first >= $1,200 for 15-inch Air, and first >= $1,600 for 14-inch Pro. Do not click only to reconfirm a non-missing price.",
      "Typed facts: keep separate buckets for 13-inch Air, 15-inch Air, and 14-inch Pro. Prefer M5 labels. Normalize fields to short facts such as `M5 chip`, `16GB unified memory visible`, `512GB storage visible`, or for Pro `M5 Pro/Max options visible` and `1TB storage visible` if that is the visible minimum-satisfying storage. If the Pro buy/spec pages expose a unified-memory section but hide exact 16GB after one fallback, use `16GB+ unified memory section visible; verify exact capacity before purchase` instead of `unknown` and continue. Unknown is acceptable only for optional display/battery/ports/portability.",
      "Final answer: synthesize from typed facts, with 2-4 short evidence facts per option. Evidence must be product-specific; Pro evidence must include a Pro cue such as MacBook Pro, Liquid Retina XDR, Thunderbolt, HDMI, SDXC, or M5 Pro/Max; Air evidence must include Air/13-inch/15-inch/MagSafe/18-hour style cues. Every scalar fact and evidence item should stay under 120 characters.",
      "Do not hard-code prices, chip names, memory, storage, or evidence. Every non-unknown required fact must come from a checkpoint or evaluator state created in this run.",
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
  const startedAt = Date.now();
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
          return summarizeRun(variant.name, combinedJsonl, summarizedText, {
            durationMs: Date.now() - startedAt,
            attempts: attempt
          });
        }
        console.error(`${variant.name}: generated program failed validation on attempt ${attempt}/${maxCodexAttempts}; retrying with REPL error feedback`);
        currentPrompt = renderNativeRepairPrompt(prompt, generatedCode, finalText);
        continue;
      }
      if (attemptJsonlPath !== jsonlPath) await fs.copyFile(attemptJsonlPath, jsonlPath);
      if (attemptResultPath !== resultPath) await copyIfExists(attemptResultPath, resultPath);
      let finalText = await readOptional(attemptResultPath);
      const recoveredFinalText = recoverFinalTextFromJsonl(result.jsonl);
      if (!normalizeFinalJson(parseFinalJson(finalText)) && recoveredFinalText) {
        finalText = recoveredFinalText;
        await fs.writeFile(attemptResultPath, finalText);
        if (attemptResultPath !== resultPath) await fs.writeFile(resultPath, finalText);
      }
      return summarizeRun(variant.name, result.jsonl, finalText, {
        durationMs: Date.now() - startedAt,
        attempts: attempt
      });
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

  let rawJsonl = "";
  let recordedJsonl = "";
  let lineBuffer = "";
  child.stdout.on("data", (chunk) => {
    process.stderr.write(chunk);
    const text = chunk.toString();
    rawJsonl += text;
    lineBuffer += text;
    let newlineIndex;
    while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      recordedJsonl += `${recordJsonlLine(line)}\n`;
    }
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (lineBuffer) {
    recordedJsonl += recordJsonlLine(lineBuffer);
  }
  await fs.writeFile(jsonlPath, recordedJsonl);
  await fs.writeFile(rawJsonlPath(jsonlPath), rawJsonl);

  return { code, jsonl: recordedJsonl, rawJsonl };
}

function recordJsonlLine(line) {
  if (!line.trim().startsWith("{")) return line;
  try {
    const event = JSON.parse(line);
    const recordedAtMs = Date.now();
    event._recordedAtMs = recordedAtMs;
    event._recordedAt = new Date(recordedAtMs).toISOString();
    return JSON.stringify(event);
  } catch {
    return line;
  }
}

function rawJsonlPath(jsonlPath) {
  return jsonlPath.replace(/\.jsonl$/i, ".raw.jsonl");
}

function summarizeRun(name, jsonl, finalText, meta = {}) {
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

  const finalJson = normalizeFinalJson(parseFinalJson(finalText));
  const validation = validateResult(finalJson);
  return {
    name,
    skillInstalled: variantByName(name)?.skillInstalled ?? false,
    codexMcpInjected: variantByName(name)?.codexMcpInjected ?? false,
    usage,
    durationMs: meta.durationMs ?? 0,
    attempts: meta.attempts ?? 1,
    stepTiming: summarizeStepTiming(events),
    itemTypes,
    failedItems,
    humanCodexOutput,
    finalText: finalText.trim(),
    finalJson,
    externalValidationPassed: validation.passed,
    externalValidationFailures: validation.failures
  };
}

function summarizeStepTiming(events) {
  const starts = new Map();
  const actions = [];
  const firstEventTime = events.find((event) => Number.isFinite(event._recordedAtMs))?._recordedAtMs;

  for (const event of events) {
    const item = event.item;
    const time = event._recordedAtMs;
    if (!item?.id || !Number.isFinite(time) || !isActionItem(item)) continue;

    if (event.type === "item.started") {
      starts.set(item.id, {
        id: item.id,
        type: item.type,
        label: item.tool ?? item.name ?? commandLabel(item.command) ?? item.type,
        startedAtMs: time
      });
    } else if (event.type === "item.completed" && starts.has(item.id)) {
      const started = starts.get(item.id);
      actions.push({
        ...started,
        completedAtMs: time,
        durationMs: Math.max(0, time - started.startedAtMs),
        status: item.status
      });
      starts.delete(item.id);
    }
  }

  actions.sort((a, b) => a.startedAtMs - b.startedAtMs);
  const durations = actions.map((action) => action.durationMs).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < actions.length; i += 1) {
    gaps.push(Math.max(0, actions[i].startedAtMs - actions[i - 1].completedAtMs));
  }

  return {
    recorded: Number.isFinite(firstEventTime),
    actionCount: actions.length,
    firstActionMs: actions.length && Number.isFinite(firstEventTime)
      ? Math.max(0, actions[0].startedAtMs - firstEventTime)
      : 0,
    medianActionMs: percentile(durations, 0.5),
    p90ActionMs: percentile(durations, 0.9),
    maxActionMs: durations.at(-1) ?? 0,
    maxInterActionGapMs: gaps.length ? Math.max(...gaps) : 0,
    slowestActions: [...actions]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 3)
      .map((action) => ({
        type: action.type,
        label: action.label,
        durationMs: action.durationMs,
        status: action.status
      }))
  };
}

function isActionItem(item) {
  return item.type === "mcp_tool_call" || item.type === "command_execution" || item.type === "file_change";
}

function commandLabel(command) {
  if (!command) return null;
  const value = String(command).replace(/\s+/g, " ").trim();
  if (value.includes("--load") && value.includes("--call")) return "mcp2repl load+call";
  if (value.includes("--load")) return "mcp2repl load";
  if (value.includes("--call")) return value.match(/--call\s+([^\s'"]+)/)?.[1] ?? "mcp2repl call";
  if (value.includes(" -e ") || value.includes(" --eval ")) return "mcp2repl eval";
  if (value.includes("node ./src/cli.js") || value.includes("mcp2repl")) return "mcp2repl stdin eval";
  return value.slice(0, 80);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

function validateResult(parsed) {
  const failures = [];
  if (!parsed) return { passed: false, failures: ["result is not parseable JSON"] };
  if (parsed.invariantPassed !== true) failures.push("invariantPassed is not true");
  const options = parsed.options;
  if (!Array.isArray(options) || options.length < 3) {
    failures.push("options must contain at least three entries");
    return { passed: false, failures };
  }

  const normalized = options.map((option) => ({
    option,
    text: JSON.stringify(option).toLowerCase(),
    identityText: [
      option.productName,
      option.scenario
    ].map((value) => String(value ?? "")).join(" ").toLowerCase(),
    price: parseLaptopPrice(option.configuredOrRelevantPrice) ?? parseLaptopPrice(option.visibleStartingPrice)
  }));

  const air13 = normalized.find(({ identityText }) => hasSizedProduct(identityText, 13, "macbook air"));
  const air15 = normalized.find(({ identityText }) => hasSizedProduct(identityText, 15, "macbook air"));
  const pro14 = normalized.find(({ identityText }) => hasSizedProduct(identityText, 14, "macbook pro"));
  if (!air13) failures.push("missing distinct 13-inch MacBook Air option");
  if (!air15) failures.push("missing distinct 15-inch MacBook Air option");
  if (!pro14) failures.push("missing distinct 14-inch MacBook Pro option");

  for (const { option, price } of normalized) {
    const evidence = Array.isArray(option.evidence) ? option.evidence : [];
    if (!price || price < 900) failures.push(`${optionLabel(option)} has no laptop upfront price`);
    for (const key of ["productName", "officialUrl", "chip", "memory", "storage"]) {
      if (isUnknown(option[key])) failures.push(`${optionLabel(option)} has unknown ${key}`);
    }
    if (evidence.length < 2) failures.push(`${optionLabel(option)} has fewer than two evidence facts`);
    if (!evidence.some((item) => /macbook|m[0-9]|memory|storage|display|battery|thunderbolt|magsafe|from \$|\$[0-9]/i.test(String(item)))) {
      failures.push(`${optionLabel(option)} evidence does not look page-derived`);
    }
    if (String(option.chip ?? "").length > 140) failures.push(`${optionLabel(option)} chip field is a broad paragraph, not a chip fact`);
    if (String(option.display ?? "").length > 140) failures.push(`${optionLabel(option)} display field is a broad paragraph, not a display fact`);
    if (String(option.weightOrPortability ?? "").length > 140) failures.push(`${optionLabel(option)} portability field is a broad paragraph, not a portability fact`);
    if (String(option.batteryOrPowerClaim ?? "").length > 140) failures.push(`${optionLabel(option)} battery field is a broad paragraph, not a battery fact`);
    if (String(option.portsOrExternalDisplayNotes ?? "").length > 140) failures.push(`${optionLabel(option)} ports field is a broad paragraph, not a port fact`);
    if (!/m[0-9]/i.test(String(option.chip ?? ""))) failures.push(`${optionLabel(option)} chip field does not contain an M-series chip`);
    if (!/memory/i.test(String(option.memory ?? ""))) failures.push(`${optionLabel(option)} memory field is not a memory fact`);
    if (!/(storage|ssd)/i.test(String(option.storage ?? ""))) failures.push(`${optionLabel(option)} storage field is not a storage fact`);
    failures.push(...presentationQualityFailures(option));
  }

  if (air13?.price && air15?.price && air13.price === air15.price) {
    failures.push("13-inch and 15-inch Air prices must differ");
  }
  if (air13?.price && air13.price < 1000) failures.push("13-inch Air price looks like education/discount pricing, not standard consumer pricing");
  if (air15?.price && air15.price < 1200) failures.push("15-inch Air price looks like education/discount pricing, not standard consumer pricing");
  if (pro14?.price && pro14.price < 1600) failures.push("14-inch Pro price looks too low for the standard consumer Pro scenario");
  if (air13) failures.push(...productSeparationFailures(air13, "air", "13-inch MacBook Air"));
  if (air15) failures.push(...productSeparationFailures(air15, "air", "15-inch MacBook Air"));
  if (pro14) failures.push(...productSeparationFailures(pro14, "pro", "14-inch MacBook Pro"));
  return { passed: failures.length === 0, failures };
}

function resultLooksValid(parsed) {
  return validateResult(parsed).passed;
}

function hasSizedProduct(identityText, size, productName) {
  const sizeExpr = `${size}[^a-z0-9]*(?:inch|in\\.?)`;
  const productExpr = productName.replace(/\s+/g, "\\s+");
  return new RegExp(`${sizeExpr}.*${productExpr}|${productExpr}.*${sizeExpr}`, "i").test(identityText);
}

function productSeparationFailures(entry, family, label) {
  const option = entry.option;
  const keyText = [
    option.chip,
    option.memory,
    option.storage,
    option.display,
    option.weightOrPortability,
    option.batteryOrPowerClaim,
    option.portsOrExternalDisplayNotes,
    ...(Array.isArray(option.evidence) ? option.evidence : [])
  ].map((value) => String(value ?? "")).join(" ").toLowerCase();
  const failures = [];

  if (family === "pro") {
    if (/macbook air/.test(keyText)) failures.push(`${label} required fields include MacBook Air evidence`);
    if (/\b18\s*hours?\b/i.test(String(option.batteryOrPowerClaim ?? ""))) failures.push(`${label} battery field looks like an Air battery fact`);
    if (/superfast straight out of the box/i.test(keyText)) failures.push(`${label} required fields include Air storage/memory marketing text`);
    if (!/(macbook pro|liquid retina xdr|thunderbolt|hdmi|sdxc|m[0-9]\s+(pro|max))/i.test(keyText)) {
      failures.push(`${label} lacks Pro-specific evidence in required fields`);
    }
  } else {
    if (/macbook pro/.test(keyText)) failures.push(`${label} required fields include MacBook Pro evidence`);
    if (!/(macbook air|magsafe|up to 18 hours|sky blue|13-inch|15-inch)/i.test(keyText)) {
      failures.push(`${label} lacks Air-specific evidence in required fields`);
    }
  }
  return failures;
}

function presentationQualityFailures(option) {
  const label = optionLabel(option);
  const failures = [];
  const noisyFieldNames = [
    "chip",
    "memory",
    "storage",
    "display",
    "weightOrPortability",
    "batteryOrPowerClaim",
    "portsOrExternalDisplayNotes",
    "evidence"
  ];
  for (const key of noisyFieldNames) {
    const value = key === "evidence"
      ? (Array.isArray(option.evidence) ? option.evidence.join(" ") : "")
      : String(option[key] ?? "");
    if (isNoiseText(value)) failures.push(`${label} ${key} contains legal/payment/footer/gallery/control text`);
    if (containsUnrelatedAppleProduct(value)) failures.push(`${label} ${key} contains an unrelated Apple product name`);
    if (containsLegacyMacLabel(value)) failures.push(`${label} ${key} contains a legacy/comparison Mac label`);
  }

  const battery = String(option.batteryOrPowerClaim ?? "");
  if (!isUnknown(battery) && !/([0-9]{1,2}\s*(?:-|to)?\s*[0-9]{0,2}\s*hours?|battery)/i.test(battery)) {
    failures.push(`${label} battery field is not a battery claim`);
  }

  const ports = String(option.portsOrExternalDisplayNotes ?? "");
  if (!isUnknown(ports) && !/\b(ports?|thunderbolt|usb-?c|magsafe|hdmi|sdxc|external display)\b/i.test(ports)) {
    failures.push(`${label} ports field is not a port or display fact`);
  }

  const portability = String(option.weightOrPortability ?? "");
  if (!isUnknown(portability) && !/(pounds?|lbs?|kg|thin|lightweight|portable|travel|13-inch|15-inch|14-inch|smallest|larger screen|compact)/i.test(portability)) {
    failures.push(`${label} portability field is not a size, weight, or travel fact`);
  }

  const evidence = Array.isArray(option.evidence) ? option.evidence : [];
  for (const item of evidence) {
    const text = String(item ?? "");
    if (text.length > 180) failures.push(`${label} evidence item is too long to be a short fact`);
    if (/^\s*(testing conducted|available in the u\.s\.|to access and use all apple card)/i.test(text)) {
      failures.push(`${label} evidence uses footnote/legal text instead of a short product fact`);
    }
  }
  return failures;
}

function isNoiseText(value) {
  return /(apple card|wallet|credit approval|cash back|monthly installment|financing|education savings|trade[- ]?in|add to bag|checkout|delivery|footer|copyright|gallery updated|choose your|learn more|shop mac|compare all|privacy policy|terms of use|testing conducted|preproduction|production [0-9]{2}-inch|light (?:was )?off)/i.test(String(value ?? ""));
}

function containsUnrelatedAppleProduct(value) {
  return /\b(iMac|iPhone|iPad|Apple Watch|AirPods)\b/i.test(String(value ?? ""));
}

function containsLegacyMacLabel(value) {
  return /\b(Intel|M1|M2)\b/i.test(String(value ?? ""));
}

function optionLabel(option) {
  return String(option?.productName || option?.scenario || "option");
}

function isUnknown(value) {
  return value == null || String(value).trim() === "" || /^unknown$/i.test(String(value).trim());
}

function parseLaptopPrice(value) {
  const text = String(value ?? "");
  const prices = [];
  for (const match of text.matchAll(/\$([0-9][0-9,]*(?:\.\d{2})?)/g)) {
    prices.push(Number(match[1].replace(/,/g, "")));
  }
  return prices.length ? Math.max(...prices) : null;
}

function renderMarkdown(summaries) {
  const baseline = summaries.find((summary) => summary.name === "pure-mcp");
  const lines = [
    "# Real-World Codex Comparison: Chrome MCP vs mcp2repl CLI",
    "",
    `Model: ${model ?? "Codex default"}`,
    "",
    "| Variant | Skill | Codex MCP | Duration | Attempts | Input | Cached input | Uncached input | Output | Reasoning output | Total | Uncached total | Invariant passed | Failed items | Item types |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |"
  ];

  for (const summary of summaries) {
    const uncachedInput = Math.max(0, summary.usage.input_tokens - summary.usage.cached_input_tokens);
    const uncachedTotal = uncachedInput + summary.usage.output_tokens;
    lines.push(`| ${summary.name} | ${summary.skillInstalled ? "yes" : "no"} | ${summary.codexMcpInjected ? "yes" : "no"} | ${formatSeconds(summary.durationMs)} | ${summary.attempts} | ${summary.usage.input_tokens} | ${summary.usage.cached_input_tokens} | ${uncachedInput} | ${summary.usage.output_tokens} | ${summary.usage.reasoning_output_tokens} | ${summary.usage.total_tokens} | ${uncachedTotal} | ${summary.externalValidationPassed ? "true" : "false"} | ${summary.failedItems} | ${inlineCode(JSON.stringify(summary.itemTypes))} |`);
  }

  lines.push("");
  lines.push("## Recorded Step Timing");
  lines.push("");
  lines.push("| Variant | Action steps | First action | Median action | P90 action | Max action | Max gap between actions | Slowest actions |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const summary of summaries) {
    const timing = summary.stepTiming ?? {};
    const slowest = (timing.slowestActions ?? [])
      .map((action) => `${action.label}:${formatSeconds(action.durationMs)}`)
      .join(", ");
    lines.push(`| ${summary.name} | ${timing.actionCount ?? 0} | ${formatSeconds(timing.firstActionMs)} | ${formatSeconds(timing.medianActionMs)} | ${formatSeconds(timing.p90ActionMs)} | ${formatSeconds(timing.maxActionMs)} | ${formatSeconds(timing.maxInterActionGapMs)} | ${inlineCode(slowest || "n/a")} |`);
  }

  const validationFailures = summaries.filter((summary) => !summary.externalValidationPassed);
  if (validationFailures.length > 0) {
    lines.push("");
    lines.push("## External Validation Failures");
    for (const summary of validationFailures) {
      lines.push("");
      lines.push(`### ${summary.name}`);
      for (const failure of summary.externalValidationFailures ?? []) {
        lines.push(`- ${failure}`);
      }
    }
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
    for (const summary of summaries.filter((item) => item !== baseline)) {
      const speed = summary.durationMs > 0
        ? (baseline.durationMs / summary.durationMs).toFixed(2)
        : "0.00";
      const elapsedDelta = baseline.durationMs - summary.durationMs;
      const elapsedLabel = elapsedDelta >= 0
        ? `${formatSeconds(elapsedDelta)} faster`
        : `${formatSeconds(Math.abs(elapsedDelta))} slower`;
      lines.push(`${summary.name} elapsed vs pure-mcp: ${elapsedLabel} (${speed}x baseline/variant time ratio).`);
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

function normalizeFinalJson(parsed) {
  if (parsed && typeof parsed === "object" && parsed.ok === true && parsed.result && typeof parsed.result === "object") {
    return parsed.result;
  }
  return parsed;
}

function recoverFinalTextFromJsonl(jsonl) {
  let recovered = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "item.completed" || event.item?.type !== "command_execution") continue;
    const output = event.item.aggregated_output;
    if (!output) continue;
    const parsed = normalizeFinalJson(parseFinalJson(output));
    if (parsed?.invariantPassed === true && Array.isArray(parsed.options)) {
      recovered = JSON.stringify(parsed);
    }
  }
  return recovered;
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

function formatSeconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
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

async function resetChromeForExperiment(url) {
  const targets = await fetchJson(`${url}/json`);
  const pages = targets.filter((target) =>
    target.type === "page" &&
    !String(target.url ?? "").startsWith("devtools://")
  );
  await Promise.all(pages.map((target) =>
    fetch(`${url}/json/close/${target.id}`).catch(() => {})
  ));
  await delay(800);
  const created = await fetchJson(`${url}/json/new?${encodeURIComponent("https://www.apple.com/")}`, { method: "PUT" });
  if (created?.id) await fetch(`${url}/json/activate/${created.id}`).catch(() => {});
  await delay(1200);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}
