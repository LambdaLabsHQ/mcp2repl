#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.pure || !args.interactive || !args.scripted || !args.out) {
  console.error([
    "Usage:",
    "  node examples/real-world-codex-comparison/stitch-comparison-video.mjs \\",
    "    --pure <pure-composite.mp4> \\",
    "    --interactive <interactive-composite.mp4> \\",
    "    --scripted <scripted-composite.mp4> \\",
    "    --out <comparison.mp4> [--poster <comparison.jpg>] [--poster-time 90]"
  ].join("\n"));
  process.exit(2);
}

const inputs = [
  { name: "pure", path: path.resolve(args.pure) },
  { name: "interactive", path: path.resolve(args.interactive) },
  { name: "scripted", path: path.resolve(args.scripted) }
];
const outPath = path.resolve(args.out);
const posterPath = args.poster ? path.resolve(args.poster) : null;
const posterTime = Number(args.posterTime ?? 90);

await fs.mkdir(path.dirname(outPath), { recursive: true });
if (posterPath) await fs.mkdir(path.dirname(posterPath), { recursive: true });

const durations = await Promise.all(inputs.map(async (input) => ({
  ...input,
  duration: await probeDuration(input.path)
})));
const maxDuration = Math.max(...durations.map((input) => input.duration));
const filter = durations.map((input, index) => {
  const pad = Math.max(0, maxDuration - input.duration);
  const chain = [
    "scale=1700:-2",
    "fps=24",
    "setpts=PTS-STARTPTS",
    pad > 0.05 ? `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : null
  ].filter(Boolean).join(",");
  return `[${index}:v]${chain}[v${index}]`;
}).join(";") + ";[v0][v1][v2]vstack=inputs=3[v]";

await run("ffmpeg", [
  "-hide_banner",
  "-y",
  ...inputs.flatMap((input) => ["-i", input.path]),
  "-filter_complex",
  filter,
  "-map",
  "[v]",
  "-t",
  maxDuration.toFixed(3),
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  outPath
]);

if (posterPath) {
  await run("ffmpeg", [
    "-hide_banner",
    "-y",
    "-ss",
    String(Math.min(Math.max(0, posterTime), Math.max(0, maxDuration - 1))),
    "-i",
    outPath,
    "-frames:v",
    "1",
    "-update",
    "1",
    "-q:v",
    "2",
    posterPath
  ]);
}

console.log(JSON.stringify({
  out: outPath,
  poster: posterPath,
  duration: maxDuration,
  inputs: durations.map(({ name, path, duration }) => ({ name, path, duration }))
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pure") parsed.pure = argv[++i];
    else if (arg === "--interactive") parsed.interactive = argv[++i];
    else if (arg === "--scripted") parsed.scripted = argv[++i];
    else if (arg === "--out") parsed.out = argv[++i];
    else if (arg === "--poster") parsed.poster = argv[++i];
    else if (arg === "--poster-time") parsed.posterTime = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function probeDuration(filePath) {
  const result = await capture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  return Number(result.trim());
}

async function capture(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}`);
  return stdout;
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
