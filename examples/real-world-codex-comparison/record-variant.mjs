#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const variant = process.argv[2];
if (!variant || !["pure-mcp", "interactive-repl", "scripted-repl"].includes(variant)) {
  console.error("Usage: node examples/real-world-codex-comparison/record-variant.mjs <pure-mcp|interactive-repl|scripted-repl>");
  process.exit(2);
}

const chromeUrl = process.env.REAL_WORLD_CHROME_BROWSER_URL ?? "http://127.0.0.1:9223";
const configPath = process.env.REAL_WORLD_CHROME_CONFIG
  ? path.resolve(process.env.REAL_WORLD_CHROME_CONFIG)
  : path.join(rootDir, ".tmp", "recordings", "chrome-devtools-browserurl.json");
const stamp = timestamp();
const outDir = path.join(rootDir, ".tmp", "recordings", `${stamp}-${variant}-tui`);
const logPath = path.join(outDir, "experiment.log");

await ensureChrome(chromeUrl);
await fsp.mkdir(outDir, { recursive: true });
await fsp.writeFile(logPath, "");
await fsp.rm(path.join(rootDir, ".tmp", "real-world-codex-comparison", "apple-task-harness.js"), { force: true });

const recorder = spawn(process.execPath, [
  path.join(rootDir, "examples", "real-world-codex-comparison", "record-dashboard.mjs"),
  outDir,
  logPath
], {
  cwd: rootDir,
  env: {
    ...process.env,
    RECORD_CHROME_URL: chromeUrl,
    RECORD_LABEL: `${variant} Codex TUI`,
    RECORD_FPS: process.env.RECORD_FPS ?? "2"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
const recorderLog = fs.createWriteStream(path.join(outDir, "recorder.log"));
recorder.stderr.pipe(recorderLog);
await fsp.writeFile(path.join(outDir, "recorder.pid"), `${recorder.pid}\n`);

let stopped = false;
async function stopRecorder() {
  if (stopped) return;
  stopped = true;
  recorder.kill("SIGTERM");
  await new Promise((resolve) => recorder.once("close", resolve));
}

process.on("SIGINT", () => {
  void stopRecorder().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void stopRecorder().finally(() => process.exit(143));
});

console.error(`Recording ${variant} to ${path.relative(rootDir, outDir)}`);
const experiment = spawn("npm", ["run", "experiment:real-world"], {
  cwd: rootDir,
  env: {
    ...process.env,
    CODEX_HUMAN_OUTPUT: "1",
    CODEX_MODEL: process.env.CODEX_MODEL ?? "gpt-5.5",
    CODEX_ATTEMPTS: process.env.CODEX_ATTEMPTS ?? "1",
    CODEX_RETRY_DELAY_MS: process.env.CODEX_RETRY_DELAY_MS ?? "30000",
    CODEX_VARIANTS: variant,
    MCP2REPL_MAX_OUTPUT_CHARS: process.env.MCP2REPL_MAX_OUTPUT_CHARS ?? "20000",
    REAL_WORLD_CHROME_BROWSER_URL: chromeUrl,
    REAL_WORLD_CHROME_CONFIG: configPath
  },
  stdio: ["ignore", "pipe", "pipe"]
});
const experimentLog = fs.createWriteStream(logPath, { flags: "a" });
experiment.stdout.pipe(process.stdout);
experiment.stderr.pipe(process.stderr);
experiment.stdout.pipe(experimentLog);
experiment.stderr.pipe(experimentLog);

const code = await new Promise((resolve, reject) => {
  experiment.on("error", reject);
  experiment.on("close", resolve);
});
await new Promise((resolve) => experimentLog.end(resolve));
await stopRecorder();
recorderLog.end();

console.error(`Recording directory: ${path.relative(rootDir, outDir)}`);
if (code !== 0) process.exit(code);

async function ensureChrome(url) {
  try {
    const response = await fetch(`${url}/json/version`);
    if (response.ok) return;
  } catch {
    // handled below
  }
  throw new Error(`Chrome remote debugging endpoint is not available: ${url}`);
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "T",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "Z"
  ].join("");
}
