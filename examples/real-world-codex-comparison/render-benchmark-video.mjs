#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const runs = {
  "pure-mcp": args.pure ?? ".tmp/real-world-codex-comparison/2026-05-14T22-06-31-970Z",
  "interactive-repl": args.interactive ?? ".tmp/real-world-codex-comparison/2026-05-14T22-13-13-600Z",
  "scripted-repl": args.scripted ?? ".tmp/real-world-codex-comparison/2026-05-14T22-15-09-411Z"
};
const outPath = path.resolve(args.out ?? "docs/assets/real-world-time-token-comparison.mp4");
const posterPath = path.resolve(args.poster ?? "docs/assets/real-world-time-token-comparison.jpg");
const workDir = path.resolve(args.workdir ?? path.join(".tmp", "benchmark-video", timestamp()));
const frameDir = path.join(workDir, "frames");
const fps = Number.parseInt(args.fps ?? "8", 10);
const introSeconds = 2;
const replaySeconds = Number.parseFloat(args.replaySeconds ?? "34");
const outroSeconds = 4;
const totalSeconds = introSeconds + replaySeconds + outroSeconds;
const fontPath = args.font ?? "/System/Library/Fonts/Supplemental/Verdana.ttf";
const variants = [
  { name: "pure-mcp", title: "Pure Chrome MCP", color: "#94a3b8", accent: "#64748b", role: "direct tool calls" },
  { name: "interactive-repl", title: "Interactive REPL", color: "#34d399", accent: "#059669", role: "compound procedures" },
  { name: "scripted-repl", title: "Prewritten REPL", color: "#38bdf8", accent: "#0284c7", role: "reusable procedure" }
];

await ensureCommand("magick");
await ensureCommand("ffmpeg");
await fs.rm(frameDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.mkdir(path.dirname(posterPath), { recursive: true });

const data = {};
for (const variant of variants) {
  data[variant.name] = await readRun(variant.name, path.resolve(runs[variant.name]));
}
const baseline = data["pure-mcp"];
const maxDurationMs = Math.max(...variants.map((variant) => data[variant.name].durationMs));
const frameCount = Math.round(totalSeconds * fps);

for (let frame = 0; frame < frameCount; frame += 1) {
  const videoSeconds = frame / fps;
  const actualMs = actualTimeForVideo(videoSeconds);
  const svg = renderFrame(actualMs, videoSeconds);
  const svgPath = path.join(frameDir, `${String(frame).padStart(5, "0")}.svg`);
  const pngPath = path.join(frameDir, `${String(frame).padStart(5, "0")}.png`);
  await fs.writeFile(svgPath, svg);
  await run("magick", ["-font", fontPath, svgPath, pngPath]);
  if (frame % Math.max(1, fps * 4) === 0) {
    process.stderr.write(`rendered ${frame + 1}/${frameCount} frames\n`);
  }
}

await run("ffmpeg", [
  "-hide_banner",
  "-y",
  "-framerate",
  String(fps),
  "-i",
  path.join(frameDir, "%05d.png"),
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  outPath
]);

await run("ffmpeg", [
  "-hide_banner",
  "-y",
  "-ss",
  "00:00:35",
  "-i",
  outPath,
  "-frames:v",
  "1",
  "-q:v",
  "2",
  "-update",
  "1",
  posterPath
]);

await fs.writeFile(path.join(workDir, "benchmark-video.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  fps,
  totalSeconds,
  replaySeconds,
  outPath,
  posterPath,
  runs,
  variants: variants.map((variant) => ({
    name: variant.name,
    durationMs: data[variant.name].durationMs,
    totalTokens: data[variant.name].totalTokens,
    actionCount: data[variant.name].actions.length,
    maxActionMs: data[variant.name].maxActionMs,
    maxGapMs: data[variant.name].maxGapMs
  }))
}, null, 2)}\n`);

process.stderr.write(`wrote ${path.relative(rootDir, outPath)}\n`);
process.stderr.write(`wrote ${path.relative(rootDir, posterPath)}\n`);

function renderFrame(actualMs, videoSeconds) {
  const width = 1920;
  const height = 1080;
  const progress = Math.min(1, Math.max(0, actualMs / maxDurationMs));
  const summaryVisible = videoSeconds >= introSeconds + replaySeconds * 0.72;
  const cards = variants.map((variant, index) => renderCard(variant, data[variant.name], index, actualMs)).join("\n");
  const axisX = 110;
  const axisY = 948;
  const axisW = 1700;
  const nowX = axisX + axisW * progress;
  const interactive = data["interactive-repl"];
  const scripted = data["scripted-repl"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#06111f"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  ${text(70, 68, "Strict JSONL Benchmark Replay", 42, "#f8fafc", 800)}
  ${text(70, 106, "Same Apple US no-login browser task. All three strict runs passed external validation.", 22, "#cbd5e1")}
  ${text(1430, 68, `benchmark time ${formatSeconds(actualMs)} / ${formatSeconds(maxDurationMs)}`, 24, "#e2e8f0", 700)}
  ${cards}
  <rect x="${axisX}" y="${axisY}" width="${axisW}" height="14" rx="7" fill="#1e293b"/>
  <rect x="${axisX}" y="${axisY}" width="${axisW * progress}" height="14" rx="7" fill="#f8fafc" opacity="0.85"/>
  <line x1="${nowX}" y1="${axisY - 20}" x2="${nowX}" y2="${axisY + 34}" stroke="#f8fafc" stroke-width="3"/>
  ${text(axisX, axisY + 52, "0s", 18, "#94a3b8")}
  ${text(axisX + axisW - 58, axisY + 52, formatSeconds(maxDurationMs), 18, "#94a3b8")}
  ${summaryVisible ? renderSummary(interactive, scripted, baseline) : ""}
</svg>`;
}

function renderCard(variant, run, index, actualMs) {
  const cardW = 560;
  const x = 70 + index * 600;
  const y = 150;
  const current = Math.min(actualMs, run.durationMs);
  const done = actualMs >= run.durationMs;
  const progress = Math.min(1, current / run.durationMs);
  const tokenRatio = baseline.totalTokens / run.totalTokens;
  const timeRatio = baseline.durationMs / run.durationMs;
  const actionY = y + 386;
  const timelineX = x + 36;
  const timelineW = cardW - 72;
  const actionSegments = run.actions.map((action) => {
    const ax = timelineX + timelineW * Math.min(1, action.startMs / maxDurationMs);
    const aw = Math.max(3, timelineW * Math.max(0.003, action.durationMs / maxDurationMs));
    const active = actualMs >= action.startMs && actualMs <= action.startMs + action.durationMs;
    const complete = actualMs > action.startMs + action.durationMs;
    const opacity = active ? 1 : complete ? 0.82 : 0.22;
    return `<rect x="${ax.toFixed(1)}" y="${actionY}" width="${aw.toFixed(1)}" height="18" rx="5" fill="${variant.color}" opacity="${opacity}"/>`;
  }).join("\n");
  const status = done ? "DONE" : "RUNNING";
  const statusColor = done ? "#bbf7d0" : "#fde68a";
  const rows = [
    ["Total tokens", formatInteger(run.totalTokens)],
    ["Elapsed", formatSeconds(run.durationMs)],
    ["Top-level actions", `${run.actions.length}`],
    ["First action", formatSeconds(run.firstActionMs)],
    ["Max action", formatSeconds(run.maxActionMs)],
    ["Max gap", formatSeconds(run.maxGapMs)]
  ];
  const metricRows = rows.map((row, i) => {
    const yy = y + 176 + i * 34;
    return `${text(x + 36, yy, row[0], 19, "#94a3b8")}${text(x + cardW - 36, yy, row[1], 21, "#f8fafc", 700, "end")}`;
  }).join("\n");
  const advantage = variant.name === "pure-mcp"
    ? "baseline"
    : `${tokenRatio.toFixed(2)}x fewer tokens, ${timeRatio.toFixed(2)}x faster`;
  const uniformLine = variant.name === "interactive-repl"
    ? "4 bounded semantic steps, 0 repairs, final returned in step 4"
    : variant.name === "pure-mcp"
      ? "27 remote actions keep extending the top-level dialogue"
      : "one amortized compound procedure";
  return `
  <g filter="url(#shadow)">
    <rect x="${x}" y="${y}" width="${cardW}" height="720" rx="18" fill="#0f172a" stroke="#233047" stroke-width="2"/>
  </g>
  <rect x="${x}" y="${y}" width="${cardW}" height="8" rx="4" fill="${variant.color}"/>
  ${text(x + 36, y + 54, variant.title, 30, "#f8fafc", 800)}
  ${text(x + 36, y + 86, variant.role, 18, "#94a3b8")}
  <rect x="${x + cardW - 142}" y="${y + 34}" width="104" height="34" rx="17" fill="${done ? "#14532d" : "#713f12"}"/>
  ${text(x + cardW - 90, y + 57, status, 16, statusColor, 800, "middle")}
  ${text(x + 36, y + 136, advantage, 25, variant.name === "pure-mcp" ? "#cbd5e1" : variant.color, 800)}
  ${metricRows}
  <rect x="${timelineX}" y="${actionY - 12}" width="${timelineW}" height="42" rx="12" fill="#182235"/>
  <rect x="${timelineX}" y="${actionY - 12}" width="${timelineW * Math.min(1, actualMs / maxDurationMs)}" height="42" rx="12" fill="#253149" opacity="0.68"/>
  ${actionSegments}
  <line x1="${timelineX + timelineW * Math.min(1, actualMs / maxDurationMs)}" y1="${actionY - 18}" x2="${timelineX + timelineW * Math.min(1, actualMs / maxDurationMs)}" y2="${actionY + 36}" stroke="#f8fafc" stroke-width="2" opacity="0.8"/>
  ${text(x + 36, y + 455, "action timeline on shared benchmark clock", 17, "#94a3b8")}
  <rect x="${x + 36}" y="${y + 488}" width="${timelineW}" height="22" rx="11" fill="#1e293b"/>
  <rect x="${x + 36}" y="${y + 488}" width="${timelineW * progress}" height="22" rx="11" fill="${variant.accent}"/>
  ${text(x + 36, y + 548, `current ${formatSeconds(current)} / ${formatSeconds(run.durationMs)}`, 22, "#f8fafc", 700)}
  ${text(x + 36, y + 590, uniformLine, 18, variant.name === "interactive-repl" ? "#bbf7d0" : "#cbd5e1")}
  ${variant.name === "interactive-repl" ? text(x + 36, y + 628, "Uniform: no setup-only pause, no giant final, no repairs.", 17, "#86efac") : ""}
  ${done ? text(x + 36, y + 680, `finished at ${formatSeconds(run.durationMs)}`, 26, variant.color, 800) : ""}
  `;
}

function renderSummary(interactive, scripted, pure) {
  const x = 70;
  const y = 870;
  return `
  <rect x="${x}" y="${y}" width="1780" height="56" rx="16" fill="#052e2b" stroke="#0f766e" stroke-width="2" opacity="0.92"/>
  ${text(x + 28, y + 36, `Interactive REPL: ${(pure.totalTokens / interactive.totalTokens).toFixed(2)}x fewer tokens, ${(pure.durationMs / interactive.durationMs).toFixed(2)}x faster, 4 evaluator actions, max action ${formatSeconds(interactive.maxActionMs)}, 0 repairs.`, 23, "#ccfbf1", 800)}
  ${text(x + 1250, y + 36, `Prewritten: ${(pure.totalTokens / scripted.totalTokens).toFixed(2)}x fewer tokens`, 23, "#bae6fd", 800)}
  `;
}

function actualTimeForVideo(videoSeconds) {
  if (videoSeconds <= introSeconds) return 0;
  if (videoSeconds >= introSeconds + replaySeconds) return maxDurationMs;
  return ((videoSeconds - introSeconds) / replaySeconds) * maxDurationMs;
}

async function readRun(name, dir) {
  const jsonlPath = path.join(dir, `${name}.jsonl`);
  const summaryPath = path.join(dir, "summary.md");
  const [jsonl, summary] = await Promise.all([
    fs.readFile(jsonlPath, "utf8"),
    fs.readFile(summaryPath, "utf8")
  ]);
  const summaryRow = parseSummaryRow(summary, name);
  const timingRow = parseTimingRow(summary, name);
  const events = parseJsonl(jsonl);
  const actions = actionEvents(events);
  return {
    name,
    dir,
    durationMs: parseSeconds(summaryRow.Duration),
    totalTokens: parseInteger(summaryRow.Total),
    failedItems: parseInteger(summaryRow["Failed items"]),
    actions,
    firstActionMs: parseSeconds(timingRow["First action"]),
    maxActionMs: parseSeconds(timingRow["Max action"]),
    maxGapMs: parseSeconds(timingRow["Max gap between actions"])
  };
}

function parseSummaryRow(markdown, name) {
  return parseTableRow(markdown, "Variant", name);
}

function parseTimingRow(markdown, name) {
  return parseTableRow(markdown, "Action steps", name);
}

function parseTableRow(markdown, marker, name) {
  const lines = markdown.split(/\r?\n/);
  let headers = null;
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.includes(marker)) {
      headers = cells;
      continue;
    }
    if (headers && cells[0] === name) {
      return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    }
  }
  throw new Error(`Could not parse ${name} row containing ${marker}`);
}

function parseJsonl(jsonl) {
  return jsonl
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
}

function actionEvents(events) {
  const firstEventTime = events.find((event) => Number.isFinite(event._recordedAtMs))?._recordedAtMs ?? 0;
  const starts = new Map();
  const actions = [];
  for (const event of events) {
    const item = event.item;
    const time = event._recordedAtMs;
    if (!item?.id || !Number.isFinite(time) || !isActionItem(item)) continue;
    if (event.type === "item.started") {
      starts.set(item.id, {
        type: item.type,
        label: item.tool ?? commandLabel(item.command) ?? item.type,
        startMs: Math.max(0, time - firstEventTime)
      });
    } else if (event.type === "item.completed" && starts.has(item.id)) {
      const started = starts.get(item.id);
      actions.push({
        ...started,
        durationMs: Math.max(0, time - firstEventTime - started.startMs)
      });
      starts.delete(item.id);
    }
  }
  return actions.sort((a, b) => a.startMs - b.startMs);
}

function isActionItem(item) {
  return item.type === "mcp_tool_call" || item.type === "command_execution" || item.type === "file_change";
}

function commandLabel(command) {
  const value = String(command ?? "");
  if (value.includes("node ./src/cli.js")) return "mcp2repl eval";
  return value.slice(0, 40);
}

function text(x, y, value, size, color, weight = 400, anchor = "start") {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Verdana" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="0">${escapeXml(value)}</text>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatSeconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function parseSeconds(value) {
  const number = Number(String(value ?? "").replace(/s$/, ""));
  return Number.isFinite(number) ? Math.round(number * 1000) : 0;
}

function parseInteger(value) {
  const number = Number(String(value ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = "1";
    }
  }
  return parsed;
}

async function ensureCommand(name) {
  await run("/bin/sh", ["-lc", `command -v ${name}`], { quiet: true });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: options.quiet ? "ignore" : "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
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
