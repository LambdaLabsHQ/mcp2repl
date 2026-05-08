#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativePath = path.join(rootDir, "examples", "chrome-research-task.native.json");
const replPath = path.join(rootDir, "examples", "chrome-research-task.repl.js");

const nativeCalls = JSON.parse(fs.readFileSync(nativePath, "utf8"));
const replCode = fs.readFileSync(replPath, "utf8");

const nativePayloadBytes = Buffer.byteLength(JSON.stringify(nativeCalls), "utf8");
const replPayloadBytes = Buffer.byteLength(JSON.stringify({ tool: "eval", args: { code: replCode } }), "utf8");
const nativeDecisionPoints = nativeCalls.length;
const replDecisionPoints = 1;

const rows = [
  ["Top-level agent tool calls", nativeCalls.length, 1],
  ["Agent decision points", nativeDecisionPoints, replDecisionPoints],
  ["Agent-facing payload bytes", nativePayloadBytes, replPayloadBytes],
  ["Where polling lives", "agent loop", "JavaScript loop"],
  ["Where errors are handled", "agent prompt state", "throw/catch in code"],
  ["Reusable artifact", "transcript", "script"]
];

const nativeBytes = nativePayloadBytes.toLocaleString("en-US");
const replBytes = replPayloadBytes.toLocaleString("en-US");
const callReduction = ((1 - 1 / nativeCalls.length) * 100).toFixed(1);
const byteReduction = ((1 - replPayloadBytes / nativePayloadBytes) * 100).toFixed(1);

console.log("| Metric | Native chrome-devtools-mcp | MCP-2-REPL |");
console.log("| --- | ---: | ---: |");
for (const [metric, nativeValue, replValue] of rows) {
  console.log(`| ${metric} | ${nativeValue} | ${replValue} |`);
}
console.log("");
console.log(`Native payload: ${nativeBytes} bytes`);
console.log(`REPL payload: ${replBytes} bytes`);
console.log(`Top-level call reduction: ${callReduction}%`);
console.log(`Agent-facing payload reduction: ${byteReduction}%`);
