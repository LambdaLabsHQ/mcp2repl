#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const outDir = path.resolve(process.argv[2] ?? ".tmp/recordings/dashboard");
const logFile = path.resolve(process.argv[3] ?? path.join(outDir, "experiment.log"));
const browserUrl = process.env.RECORD_CHROME_URL ?? "http://127.0.0.1:9223";
const label = process.env.RECORD_LABEL ?? "mcp2repl experiment";
const fps = Number.parseInt(process.env.RECORD_FPS ?? "2", 10);
const quality = Number.parseInt(process.env.RECORD_QUALITY ?? "70", 10);
const frameDir = path.join(outDir, "frames");
const videoPath = path.join(outDir, "recording.mp4");
const startedAt = new Date();

let frameCount = 0;
let stopping = false;
let latestBrowserImage = "";
let latestBrowserTitle = "";
let latestBrowserUrl = "";
let timer;
let dashboardSocket;
let dashboardTargetId;
let nextId = 1;
const targetSockets = new Map();

await fs.rm(frameDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(logFile, "", { flag: "a" });

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const dashboardUrl = `http://127.0.0.1:${port}/`;

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

await openDashboard(dashboardUrl);
const target = await waitForDashboardTarget(dashboardUrl, 15000);
await ensureDashboardSocket(target);

await fs.writeFile(path.join(outDir, "recording.json"), `${JSON.stringify({
  browserUrl,
  dashboardUrl,
  label,
  fps,
  quality,
  startedAt: startedAt.toISOString(),
  mode: "dashboard: codex log plus browser screenshot"
}, null, 2)}\n`);

console.error(`Recording dashboard ${dashboardUrl} to ${outDir}`);
timer = setInterval(() => void captureDashboardFrame(), Math.max(250, Math.round(1000 / fps)));
await captureDashboardFrame();
await new Promise(() => {});

async function handleRequest(request, response) {
  if (request.url === "/state") {
    const rawLog = await readTail(logFile, 300000);
    const log = formatCodexLog(rawLog);
    const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({
      label,
      elapsed: formatElapsed(elapsedSeconds),
      elapsedSeconds,
      log,
      browserImage: latestBrowserImage,
      browserTitle: latestBrowserTitle,
      browserUrl: latestBrowserUrl
    }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(renderDashboardHtml());
}

async function captureDashboardFrame() {
  if (stopping) return;
  try {
    await captureBrowserImage();
    const result = await dashboardSend("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      fromSurface: true
    });
    const filename = path.join(frameDir, `${String(frameCount).padStart(6, "0")}.jpg`);
    frameCount += 1;
    await fs.writeFile(filename, Buffer.from(result.data, "base64"));
  } catch (error) {
    await fs.writeFile(path.join(outDir, "last-capture-error.txt"), `${String(error?.stack ?? error)}\n`).catch(() => {});
  }
}

async function captureBrowserImage() {
  const targets = await listTargets();
  const target = targets.find((item) =>
    item.type === "page" &&
    item.webSocketDebuggerUrl &&
    /^https?:\/\//.test(String(item.url ?? "")) &&
    !String(item.url).startsWith(dashboardUrl) &&
    !/^https?:\/\/(127\.0\.0\.1|localhost):/i.test(String(item.url ?? ""))
  );
  if (!target) return;
  latestBrowserTitle = target.title ?? "";
  latestBrowserUrl = target.url ?? "";
  const socket = await getTargetSocket(target);
  const result = await targetSend(socket, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 62,
    fromSurface: true
  });
  latestBrowserImage = `data:image/jpeg;base64,${result.data}`;
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    if (dashboardSocket?.readyState === WebSocket.OPEN) dashboardSocket.close();
    for (const socket of targetSockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
    server.close();
    await writeVideo();
  } finally {
    process.exit(0);
  }
}

async function writeVideo() {
  if (frameCount === 0) {
    await fs.writeFile(path.join(outDir, "recording-error.txt"), "No frames captured.\n");
    return;
  }
  await fs.writeFile(path.join(outDir, "recording.json"), `${JSON.stringify({
    browserUrl,
    dashboardUrl,
    label,
    fps,
    quality,
    startedAt: startedAt.toISOString(),
    stoppedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    frameCount,
    videoPath,
    mode: "dashboard: codex log plus browser screenshot"
  }, null, 2)}\n`);
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(frameDir, "%06d.jpg"),
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-pix_fmt",
      "yuv420p",
      videoPath
    ], { stdio: "inherit" });
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

async function openDashboard(url) {
  const response = await fetch(`${browserUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Failed to open dashboard: ${response.status} ${await response.text()}`);
}

async function waitForDashboardTarget(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await listTargets();
    const target = targets.find((item) => String(item.url ?? "").startsWith(url));
    if (target) return target;
    await delay(300);
  }
  throw new Error(`Dashboard target not found: ${url}`);
}

async function ensureDashboardSocket(target) {
  if (dashboardSocket?.readyState === WebSocket.OPEN && dashboardTargetId === target.id) return;
  dashboardTargetId = target.id;
  dashboardSocket = new WebSocket(target.webSocketDebuggerUrl);
  await waitSocketOpen(dashboardSocket);
  await dashboardSend("Page.enable");
}

function dashboardSend(method, params = {}) {
  return send(dashboardSocket, method, params);
}

async function getTargetSocket(target) {
  const existing = targetSockets.get(target.id);
  if (existing?.readyState === WebSocket.OPEN) return existing;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await waitSocketOpen(socket);
  targetSockets.set(target.id, socket);
  await targetSend(socket, "Page.enable").catch(() => {});
  return socket;
}

function targetSend(socket, method, params = {}) {
  return send(socket, method, params);
}

function send(socket, method, params = {}) {
  const id = nextId;
  nextId += 1;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    socket.addEventListener("message", listener);
  });
}

function waitSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function listTargets() {
  const response = await fetch(`${browserUrl}/json`);
  return response.json();
}

async function readTail(filePath, maxChars) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } catch {
    return "";
  }
}

function formatCodexLog(raw) {
  if (/OpenAI Codex|--------\nworkdir:|^codex$/m.test(raw)) {
    return tailLines(cleanOutput(raw), 260);
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("{")) {
      if (/^(===|>|Model:|# |\| |Artifacts written|[a-z-]+: \d+)/.test(trimmed)) {
        events.push(trimmed);
      }
      continue;
    }
    let item;
    try {
      item = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const formatted = formatCodexEvent(item);
    if (formatted) events.push(formatted);
  }
  const compact = coalesceEvents(events);
  return compact.slice(-220).join("\n\n");
}

function tailLines(text, maxLines) {
  return String(text).split(/\r?\n/).slice(-maxLines).join("\n");
}

function formatCodexEvent(event) {
  if (event.type === "thread.started") return `THREAD ${event.thread_id}`;
  if (event.type === "turn.started") return "TURN started";
  if (event.type === "turn.completed") {
    const usage = event.usage ?? {};
    return [
      "TURN completed",
      `tokens: input ${usage.input_tokens ?? "?"}, cached ${usage.cached_input_tokens ?? "?"}, output ${usage.output_tokens ?? "?"}, reasoning ${usage.reasoning_output_tokens ?? "?"}`
    ].join("\n");
  }
  if (event.type !== "item.started" && event.type !== "item.completed") return "";
  const item = event.item ?? {};
  const status = event.type === "item.started" ? "started" : "completed";
  if (item.type === "agent_message") {
    return `AGENT\n${clip(item.text, 900)}`;
  }
  if (item.type === "mcp_tool_call") {
    const args = summarizeValue(item.arguments);
    const result = item.result ? `\nresult: ${summarizeToolResult(item.result)}` : "";
    const error = item.error ? `\nerror: ${clip(JSON.stringify(item.error), 500)}` : "";
    return `MCP ${status}: ${item.server}.${item.tool}\nargs: ${args}${result}${error}`;
  }
  if (item.type === "command_execution") {
    const output = item.aggregated_output ? `\noutput:\n${clip(cleanOutput(item.aggregated_output), 1200)}` : "";
    const exit = item.exit_code == null ? "" : `\nexit: ${item.exit_code}`;
    return `SHELL ${status}\n$ ${clip(item.command, 700)}${exit}${output}`;
  }
  if (item.type === "file_change") {
    return `FILE CHANGE ${status}\n${clip(JSON.stringify(item, null, 2), 900)}`;
  }
  return `${String(item.type ?? "ITEM").toUpperCase()} ${status}\n${clip(JSON.stringify(item), 900)}`;
}

function summarizeToolResult(result) {
  const content = result.content;
  if (Array.isArray(content)) {
    return clip(content.map((entry) => {
      if (entry.type === "text") return entry.text;
      return JSON.stringify(entry);
    }).join("\n"), 900);
  }
  return clip(JSON.stringify(result), 900);
}

function summarizeValue(value) {
  return clip(JSON.stringify(value), 700);
}

function cleanOutput(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "");
}

function clip(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n... [truncated]`;
}

function coalesceEvents(events) {
  const out = [];
  for (const event of events) {
    if (out[out.length - 1] === event) continue;
    out.push(event);
  }
  return out;
}

function renderDashboardHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>mcp2repl recording dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #101318;
      color: #f4f7fb;
      font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    header {
      height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      border-bottom: 1px solid #303844;
      background: #161b22;
    }
    .label { font-size: 22px; font-weight: 700; }
    .time { font-size: 22px; font-weight: 700; color: #85d7ff; }
    main {
      display: grid;
      grid-template-columns: 44% 56%;
      height: calc(100vh - 58px);
    }
    .log {
      border-right: 1px solid #303844;
      padding: 14px;
      overflow: hidden;
      background: #0d1117;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      line-height: 1.38;
      color: #d6deeb;
    }
    .browser {
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: #151a21;
    }
    .url {
      height: 36px;
      padding: 9px 12px;
      color: #b9c3d1;
      border-bottom: 1px solid #303844;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .viewport {
      flex: 1;
      display: grid;
      place-items: center;
      overflow: hidden;
      padding: 10px;
    }
    img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      background: white;
      box-shadow: 0 0 0 1px #303844;
    }
  </style>
</head>
<body>
  <header>
    <div class="label" id="label"></div>
    <div class="time" id="time"></div>
  </header>
  <main>
    <section class="log"><pre id="log"></pre></section>
    <section class="browser">
      <div class="url" id="url"></div>
      <div class="viewport"><img id="browser" alt="browser"></div>
    </section>
  </main>
  <script>
    async function tick() {
      const state = await fetch('/state', { cache: 'no-store' }).then((r) => r.json());
      label.textContent = state.label;
      time.textContent = 'elapsed ' + state.elapsed;
      url.textContent = state.browserTitle + '  ' + state.browserUrl;
      log.textContent = state.log || 'waiting for Codex output...';
      if (state.browserImage) browser.src = state.browserImage;
    }
    setInterval(tick, 500);
    tick();
  </script>
</body>
</html>`;
}

function formatElapsed(total) {
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
