#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const variant = process.argv[2];
if (!variant || !["pure-mcp", "interactive-repl", "scripted-repl"].includes(variant)) {
  console.error("Usage: node examples/real-world-codex-comparison/record-composite.mjs <pure-mcp|interactive-repl|scripted-repl>");
  process.exit(2);
}

const chromeUrl = process.env.REAL_WORLD_CHROME_BROWSER_URL ?? "http://127.0.0.1:9223";
const configPath = process.env.REAL_WORLD_CHROME_CONFIG
  ? path.resolve(process.env.REAL_WORLD_CHROME_CONFIG)
  : path.join(rootDir, ".tmp", "recordings", "chrome-devtools-browserurl.json");
const stamp = timestamp();
const outDir = path.join(rootDir, ".tmp", "recordings", `${stamp}-${variant}-composite`);
const terminalDir = path.join(outDir, "terminal");
const browserDir = path.join(outDir, "browser");
const castPath = path.join(terminalDir, "codex.cast");
const terminalGifPath = path.join(terminalDir, "codex.gif");
const terminalMp4Path = path.join(terminalDir, "codex.mp4");
const browserMp4Path = path.join(browserDir, "recording.mp4");
const compositeMp4Path = path.join(outDir, "composite.mp4");
const idleLimit = process.env.NATIVE_TUI_IDLE_LIMIT ?? "9999";
const strictJsonRecording = process.env.RECORD_STRICT_JSON === "1";

await ensureCommand("asciinema");
await ensureCommand("agg");
await ensureCommand("ffmpeg");
await ensureChrome(chromeUrl);
await fs.mkdir(terminalDir, { recursive: true });
await fs.mkdir(browserDir, { recursive: true });
await fs.rm(path.join(rootDir, ".tmp", "real-world-codex-comparison", "apple-task-module.js"), { force: true });
await resetChrome(chromeUrl);

const env = {
  ...process.env,
  CODEX_HUMAN_OUTPUT: strictJsonRecording ? "0" : "1",
  ...(strictJsonRecording ? { CODEX_PRETTY_JSON: "1" } : {}),
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
console.error(`Recording composite Codex ${strictJsonRecording ? "strict JSONL" : "TUI"} + Chrome for ${variant} to ${path.relative(rootDir, outDir)}`);
const browserRecorder = spawn(process.execPath, [
  path.join(rootDir, "examples", "real-world-codex-comparison", "record-cdp-screencast.mjs"),
  browserDir
], {
  cwd: rootDir,
  env: {
    ...process.env,
    RECORD_CHROME_URL: chromeUrl,
    RECORD_FPS: process.env.RECORD_FPS ?? "2",
    RECORD_LABEL: `${variant} Chrome`
  },
  stdio: ["ignore", "ignore", "pipe"]
});
await fs.writeFile(path.join(outDir, "browser-recorder.pid"), `${browserRecorder.pid}\n`);
const browserLog = await fs.open(path.join(outDir, "browser-recorder.log"), "w");
browserRecorder.stderr.on("data", (chunk) => void browserLog.write(chunk));
await delay(1200);

try {
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
} finally {
  browserRecorder.kill("SIGTERM");
  await new Promise((resolve) => browserRecorder.once("close", resolve));
  await browserLog.close();
}

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
  terminalGifPath
]);

await run("ffmpeg", [
  "-hide_banner",
  "-y",
  "-i",
  terminalGifPath,
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  "-vf",
  "pad=ceil(iw/2)*2:ceil(ih/2)*2",
  terminalMp4Path
]);

await run("ffmpeg", [
  "-hide_banner",
  "-y",
  "-i",
  terminalMp4Path,
  "-i",
  browserMp4Path,
  "-filter_complex",
  "[0:v]scale=-2:720,setpts=PTS-STARTPTS[left];[1:v]scale=-2:720,setpts=PTS-STARTPTS[right];[left][right]hstack=inputs=2:shortest=1[v]",
  "-map",
  "[v]",
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  compositeMp4Path
]);

const stoppedAt = new Date();
await fs.writeFile(path.join(outDir, "recording.json"), `${JSON.stringify({
  variant,
  mode: "composite native Codex TUI plus Chrome CDP recording",
  startedAt: startedAt.toISOString(),
  stoppedAt: stoppedAt.toISOString(),
  durationSeconds: Math.round((stoppedAt.getTime() - startedAt.getTime()) / 1000),
  terminal: { castPath, terminalGifPath, terminalMp4Path },
  browser: { browserDir, browserMp4Path },
  compositeMp4Path,
  chromeUrl,
  configPath
}, null, 2)}\n`);

console.error(`Composite recording directory: ${path.relative(rootDir, outDir)}`);

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

async function resetChrome(url) {
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
  if (created?.id) {
    await fetch(`${url}/json/activate/${created.id}`).catch(() => {});
  }
  await delay(1200);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
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

function exitCode(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(127));
    child.on("close", resolve);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
