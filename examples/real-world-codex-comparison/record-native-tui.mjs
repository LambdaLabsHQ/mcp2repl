#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const variant = process.argv[2];
if (!variant || !["pure-mcp", "interactive-repl", "scripted-repl"].includes(variant)) {
  console.error("Usage: node examples/real-world-codex-comparison/record-native-tui.mjs <pure-mcp|interactive-repl|scripted-repl>");
  process.exit(2);
}

const chromeUrl = process.env.REAL_WORLD_CHROME_BROWSER_URL ?? "http://127.0.0.1:9223";
const configPath = process.env.REAL_WORLD_CHROME_CONFIG
  ? path.resolve(process.env.REAL_WORLD_CHROME_CONFIG)
  : path.join(rootDir, ".tmp", "recordings", "chrome-devtools-browserurl.json");
const stamp = timestamp();
const outDir = path.join(rootDir, ".tmp", "recordings", `${stamp}-${variant}-native-tui`);
const castPath = path.join(outDir, "codex.cast");
const gifPath = path.join(outDir, "codex.gif");
const mp4Path = path.join(outDir, "codex.mp4");
const idleLimit = process.env.NATIVE_TUI_IDLE_LIMIT ?? "9999";

await ensureCommand("asciinema");
await ensureCommand("agg");
await ensureCommand("ffmpeg");
await ensureChrome(chromeUrl);
await fs.mkdir(outDir, { recursive: true });
await fs.rm(path.join(rootDir, ".tmp", "real-world-codex-comparison", "apple-task-module.js"), { force: true });

const env = {
  ...process.env,
  CODEX_HUMAN_OUTPUT: "1",
  CODEX_MODEL: process.env.CODEX_MODEL ?? "gpt-5.5",
  CODEX_ATTEMPTS: process.env.CODEX_ATTEMPTS ?? "1",
  CODEX_RETRY_DELAY_MS: process.env.CODEX_RETRY_DELAY_MS ?? "30000",
  CODEX_VARIANTS: variant,
  MCP2REPL_MAX_OUTPUT_CHARS: process.env.MCP2REPL_MAX_OUTPUT_CHARS ?? "20000",
  REAL_WORLD_CHROME_BROWSER_URL: chromeUrl,
  REAL_WORLD_CHROME_CONFIG: configPath,
  FORCE_COLOR: "1",
  TERM: process.env.TERM || "xterm-256color"
};

const startedAt = new Date();
console.error(`Recording native Codex TUI for ${variant} to ${path.relative(rootDir, outDir)}`);
await run("asciinema", [
  "rec",
  "--headless",
  "--overwrite",
  "--return",
  "--window-size",
  process.env.NATIVE_TUI_WINDOW_SIZE ?? "120x36",
  "--idle-time-limit",
  idleLimit,
  "--title",
  `${variant} native Codex TUI`,
  "--command",
  "npm run experiment:real-world",
  castPath
], { env });

await run("agg", [
  "--theme",
  process.env.NATIVE_TUI_THEME ?? "github-dark",
  "--idle-time-limit",
  idleLimit,
  "--cols",
  process.env.NATIVE_TUI_COLS ?? "120",
  "--rows",
  process.env.NATIVE_TUI_ROWS ?? "36",
  "--no-loop",
  castPath,
  gifPath
]);

await run("ffmpeg", [
  "-hide_banner",
  "-y",
  "-i",
  gifPath,
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  "-vf",
  "pad=ceil(iw/2)*2:ceil(ih/2)*2",
  mp4Path
]);

const stoppedAt = new Date();
await fs.writeFile(path.join(outDir, "recording.json"), `${JSON.stringify({
  variant,
  mode: "native Codex TUI via asciinema PTY capture",
  startedAt: startedAt.toISOString(),
  stoppedAt: stoppedAt.toISOString(),
  durationSeconds: Math.round((stoppedAt.getTime() - startedAt.getTime()) / 1000),
  castPath,
  gifPath,
  mp4Path,
  chromeUrl,
  configPath
}, null, 2)}\n`);

console.error(`Native TUI recording directory: ${path.relative(rootDir, outDir)}`);

async function ensureCommand(name) {
  const code = await exitCode("/bin/sh", ["-lc", `command -v ${name}`]);
  if (code !== 0) throw new Error(`Required command not found: ${name}`);
}

async function ensureChrome(url) {
  try {
    const response = await fetch(`${url}/json/version`);
    if (response.ok) return;
  } catch {
    // handled below
  }
  throw new Error(`Chrome remote debugging endpoint is not available: ${url}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: options.env ?? process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function exitCode(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", shell: options.shell ?? false });
    child.on("error", () => resolve(127));
    child.on("close", resolve);
  });
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
