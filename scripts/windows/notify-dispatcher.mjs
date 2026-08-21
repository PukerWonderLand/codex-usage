#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const [usageCliPath, upstreamCountValue, ...notificationArgs] = process.argv.slice(2);
const payload = notificationArgs.at(-1);
const upstreamCount = Number.parseInt(upstreamCountValue || "0", 10);
const upstream = notificationArgs.slice(0, -1);
const logPath = path.join(homedir(), ".codex-usage", "notify-errors.log");
const retryDelays = [0, 250, 500, 1000, 2000, 4000];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code ?? "unknown"}`));
    });
  });
}

async function recordFailure(kind, error) {
  const message = String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 240);
  await appendFile(logPath, `${new Date().toISOString()} ${kind}: ${message}\n`, "utf8").catch(() => {});
}

async function runUsageHook() {
  let lastError;
  for (const delay of retryDelays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await run(process.execPath, [usageCliPath, "hook", payload]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

if (!usageCliPath || !payload || !Number.isInteger(upstreamCount) || upstreamCount < 0) {
  await recordFailure("dispatcher", new Error("invalid managed notify arguments"));
  process.exitCode = 2;
} else if (upstream.length !== upstreamCount) {
  await recordFailure("dispatcher", new Error("upstream argument count mismatch"));
  process.exitCode = 2;
} else {
  const jobs = [runUsageHook().catch((error) => recordFailure("usage-hook", error))];
  if (upstream.length) {
    jobs.push(run(upstream[0], [...upstream.slice(1), payload]).catch((error) => recordFailure("upstream-notify", error)));
  }
  await Promise.all(jobs);
}
