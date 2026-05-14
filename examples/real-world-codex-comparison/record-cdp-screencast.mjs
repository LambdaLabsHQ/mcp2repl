#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const browserUrl = process.env.RECORD_CHROME_URL ?? "http://127.0.0.1:9222";
const outDir = path.resolve(process.argv[2] ?? ".tmp/recordings/cdp");
const fps = Number.parseInt(process.env.RECORD_FPS ?? "3", 10);
const quality = Number.parseInt(process.env.RECORD_QUALITY ?? "70", 10);
const label = process.env.RECORD_LABEL ?? "mcp2repl experiment";
const frameDir = path.join(outDir, "frames");
const videoPath = path.join(outDir, "recording.mp4");
const startedAt = new Date();

let socket;
let socketTargetId;
let nextId = 1;
let frameCount = 0;
let stopping = false;
let timer;

await fs.rm(frameDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

await fs.writeFile(path.join(outDir, "recording.json"), `${JSON.stringify({
  browserUrl,
  fps,
  quality,
  label,
  startedAt: startedAt.toISOString(),
  mode: "Page.captureScreenshot polling"
}, null, 2)}\n`);

console.error(`Recording Chrome screenshots to ${outDir}`);
timer = setInterval(() => void captureFrame(), Math.max(250, Math.round(1000 / fps)));
await captureFrame();

await new Promise(() => {});

async function captureFrame() {
  if (stopping) return;
  try {
    const target = await findPageTarget(browserUrl);
    if (!target) return;
    await ensureSocket(target);
    await injectOverlay().catch(() => {});
    const result = await send("Page.captureScreenshot", {
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

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
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
    fps,
    quality,
    label,
    startedAt: startedAt.toISOString(),
    stoppedAt: new Date().toISOString(),
    frameCount,
    durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    videoPath,
    mode: "Page.captureScreenshot polling"
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

async function ensureSocket(target) {
  if (socket?.readyState === WebSocket.OPEN && socketTargetId === target.id) return;
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  socketTargetId = target.id;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  await send("Page.enable");
  await send("Runtime.enable").catch(() => {});
}

function send(method, params = {}) {
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

async function findPageTarget(baseUrl) {
  const response = await fetch(`${baseUrl}/json`);
  const targets = await response.json();
  const pages = targets.filter((target) =>
    target.type === "page" &&
    target.webSocketDebuggerUrl &&
    !String(target.url ?? "").startsWith("devtools://") &&
    !/^https?:\/\/(127\.0\.0\.1|localhost):/i.test(String(target.url ?? ""))
  );
  return pages.find((target) => /:\/\/(?:www\.)?apple\.com\//i.test(String(target.url ?? ""))) ??
    pages.find((target) => /^https?:\/\//.test(String(target.url ?? ""))) ??
    pages[0];
}

async function injectOverlay() {
  const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  const h = String(Math.floor(elapsedSeconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(elapsedSeconds % 60).padStart(2, "0");
  const text = `${label}  elapsed ${h}:${m}:${s}`;
  await send("Runtime.evaluate", {
    expression: `(() => {
      const id = "mcp2repl-recording-overlay";
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        Object.assign(el.style, {
          position: "fixed",
          top: "18px",
          left: "18px",
          zIndex: "2147483647",
          padding: "10px 14px",
          borderRadius: "6px",
          background: "rgba(0,0,0,0.72)",
          color: "white",
          font: "600 22px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          letterSpacing: "0",
          pointerEvents: "none",
          boxShadow: "0 2px 10px rgba(0,0,0,0.3)"
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = ${JSON.stringify(text)};
      return true;
    })()`,
    awaitPromise: false,
    returnByValue: true
  });
}
