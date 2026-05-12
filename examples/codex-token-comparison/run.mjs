#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const experimentDir = path.join(rootDir, "examples", "codex-token-comparison");
const outDir = path.join(rootDir, ".tmp", "codex-token-comparison", timestamp());
const model = process.env.CODEX_MODEL || undefined;

const chromeArgs = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--headless",
  "--isolated",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--chrome-arg=--no-sandbox",
  "--chrome-arg=--disable-setuid-sandbox"
];

const dataUrl = makeDataUrl();
const evalProgram = makeEvalProgram(dataUrl);
const promptTemplate = await fs.readFile(path.join(experimentDir, "prompt.txt"), "utf8");
const prompt = promptTemplate
  .replace("DATA_URL_PLACEHOLDER", dataUrl)
  .replace("EVAL_PROGRAM_PLACEHOLDER", evalProgram);

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "prompt.txt"), prompt);

const variants = [
  {
    name: "native-chrome-mcp",
    config: [
      "mcp_servers.chrome-devtools.command=\"npx\"",
      `mcp_servers.chrome-devtools.args=${tomlStringArray(chromeArgs)}`
    ]
  },
  {
    name: "mcp2repl-wrapped-chrome-mcp",
    config: [
      "mcp_servers.chrome-repl.command=\"node\"",
      `mcp_servers.chrome-repl.args=${tomlStringArray([
        path.join(rootDir, "src", "server.js"),
        "--config",
        path.join(rootDir, "examples", "chrome-devtools.json"),
        "--server",
        "chrome-devtools"
      ])}`
    ]
  }
];

const summaries = [];
for (const variant of variants) {
  console.error(`\n=== Running ${variant.name} ===`);
  const jsonlPath = path.join(outDir, `${variant.name}.jsonl`);
  const resultPath = path.join(outDir, `${variant.name}.result.txt`);
  const summary = await runCodexVariant(variant, jsonlPath, resultPath);
  summaries.push(summary);
  console.error(`${variant.name}: ${summary.usage.total_tokens} total tokens`);
}

const markdown = renderMarkdown(summaries);
await fs.writeFile(path.join(outDir, "summary.md"), markdown);
console.log(markdown);
console.error(`\nArtifacts written to ${outDir}`);

const failed = summaries.filter((summary) => summary.finalJson?.readyInvariant !== true);
if (failed.length > 0) {
  throw new Error(`Experiment did not complete the probe invariant for: ${failed.map((summary) => summary.name).join(", ")}`);
}

async function runCodexVariant(variant, jsonlPath, resultPath) {
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--cd",
    rootDir,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    resultPath
  ];

  if (model) args.push("--model", model);
  for (const override of variant.config) {
    args.push("-c", override);
  }
  args.push(prompt);

  const child = spawn("codex", args, {
    cwd: rootDir,
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

  if (code !== 0) {
    throw new Error(`codex exec failed for ${variant.name} with exit code ${code}`);
  }

  return summarizeRun(variant.name, jsonl, await readOptional(resultPath));
}

function summarizeRun(name, jsonl, finalText) {
  const events = jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
  const itemTypes = {};

  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) {
      usage.input_tokens += event.usage.input_tokens ?? 0;
      usage.cached_input_tokens += event.usage.cached_input_tokens ?? 0;
      usage.output_tokens += event.usage.output_tokens ?? 0;
      usage.reasoning_output_tokens += event.usage.reasoning_output_tokens ?? 0;
    }
    if (event.type === "item.completed" && event.item?.type) {
      itemTypes[event.item.type] = (itemTypes[event.item.type] ?? 0) + 1;
    }
  }

  usage.total_tokens = usage.input_tokens + usage.output_tokens;

  return {
    name,
    usage,
    itemTypes,
    finalText: finalText.trim(),
    finalJson: parseFinalJson(finalText)
  };
}

function renderMarkdown(summaries) {
  const [native, repl] = summaries;
  const tokenDelta = native && repl
    ? native.usage.total_tokens - repl.usage.total_tokens
    : 0;
  const tokenReduction = native && repl && native.usage.total_tokens > 0
    ? ((tokenDelta / native.usage.total_tokens) * 100).toFixed(1)
    : "0.0";

  const lines = [
    "# Codex Token Comparison: Native Chrome MCP vs mcp2repl",
    "",
    "| Variant | Input | Cached input | Output | Reasoning output | Total | Ready invariant | Item types |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |"
  ];

  for (const summary of summaries) {
    lines.push(`| ${summary.name} | ${summary.usage.input_tokens} | ${summary.usage.cached_input_tokens} | ${summary.usage.output_tokens} | ${summary.usage.reasoning_output_tokens} | ${summary.usage.total_tokens} | ${summary.finalJson?.readyInvariant === true ? "true" : "false"} | ${inlineCode(JSON.stringify(summary.itemTypes))} |`);
  }

  lines.push("");
  if (tokenDelta >= 0) {
    lines.push(`Token delta: ${tokenDelta} fewer tokens with mcp2repl (${tokenReduction}% reduction).`);
  } else {
    lines.push(`Token delta: ${Math.abs(tokenDelta)} more tokens with mcp2repl (${Math.abs(Number(tokenReduction)).toFixed(1)}% increase).`);
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

function makeDataUrl() {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Harness Probe Booting</title>
  </head>
  <body>
    <h1>Harness Probe</h1>
    <p id="status">booting</p>
    <ul id="items"></ul>
    <a href="https://example.com/docs">docs</a>
    <script>
      console.log("probe:init");
      window.__probe = { ready: false, total: 0 };
      setTimeout(function() {
        var values = [["alpha", 7], ["beta", 14], ["gamma", 21]];
        document.title = "Harness Probe Ready";
        document.querySelector("#status").textContent = "ready: 42";
        document.querySelector("#items").innerHTML = values
          .map(function(pair) { return "<li class=\\"item\\">" + pair[0] + ":" + pair[1] + "</li>"; })
          .join("");
        window.__probe = {
          ready: true,
          total: values.reduce(function(sum, pair) { return sum + pair[1]; }, 0)
        };
        console.log("probe:ready", window.__probe.total);
      }, 600);
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html).replaceAll("'", "%27")}`;
}

function makeEvalProgram(dataUrl) {
  return `(async () => {
  const url = ${JSON.stringify(dataUrl)};

  function countConsoleMessages(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const range = text.match(/Showing\\s+\\d+-\\d+\\s+of\\s+(\\d+)/);
    if (range) return Number(range[1]);
    const ids = text.match(/msgid=/g);
    return ids ? ids.length : 0;
  }

  function countNetworkRequests(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (/No network requests|No requests/i.test(text)) return 0;
    const range = text.match(/Showing\\s+\\d+-\\d+\\s+of\\s+(\\d+)/);
    if (range) return Number(range[1]);
    const ids = text.match(/reqid=/g);
    return ids ? ids.length : 0;
  }

  await tools.new_page({ url, timeout: 1000 });
  await tools.wait_for({ text: ["ready: 42"], timeout: 3000 });

  const data = await tools.evaluate_script({
    function: "() => { const items = Array.from(document.querySelectorAll('.item')).map((el) => el.textContent); return { title: document.title, heading: document.querySelector('h1')?.textContent || '', status: document.querySelector('#status')?.textContent || '', items, computedTotal: Number(window.__probe?.total), linkHost: document.querySelector('a')?.hostname || '', readyInvariant: document.title === 'Harness Probe Ready' && document.querySelector('#status')?.textContent === 'ready: 42' && JSON.stringify(items) === JSON.stringify(['alpha:7','beta:14','gamma:21']) && Number(window.__probe?.total) === 42 }; }"
  });
  const consoleRaw = await tools.list_console_messages({ includePreservedMessages: true, pageSize: 100 });
  const networkRaw = await tools.list_network_requests({ includePreservedRequests: true, pageSize: 100 });

  return JSON.stringify({
    title: data.title,
    heading: data.heading,
    status: data.status,
    items: data.items,
    computedTotal: data.computedTotal,
    linkHost: data.linkHost,
    consoleMessages: countConsoleMessages(consoleRaw),
    networkRequests: countNetworkRequests(networkRaw),
    readyInvariant: data.readyInvariant === true
  });
})()`;
}

function tomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function inlineCode(value) {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function parseFinalJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  return null;
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
