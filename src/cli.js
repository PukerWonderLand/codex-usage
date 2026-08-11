#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createUsageServer } from "./server.js";
import {
  buildUsageReport,
  discoverCodexHomes,
  discoverSessionFiles,
  parseSessionTurns,
  summarizeUsage,
} from "./usage-core.js";
import { UsageStore } from "./usage-store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3765;
const DEFAULT_GATEWAY_MEMORY_MB = 256;
const DEFAULT_STATE_FILE = path.join(homedir(), ".codex-usage", "services.json");
const SERVICE_LOCK_WAIT_MS = 5000;
const SERVICE_LOCK_STALE_MS = 15000;
const REPORTING_PROMPT_START = "<!-- codex-usage:reporting:start -->";
const REPORTING_PROMPT_END = "<!-- codex-usage:reporting:end -->";
const REPORTING_PROMPT = `${REPORTING_PROMPT_START}
# Codex Usage Reporting

本机已安装 \`codex-usage\`，并配置了 \`agent-turn-complete\` Hook。

每次回答用户请求时：

1. 开始处理时运行 \`codex-usage turn --json\`，读取上一回合完整用量。
2. 完成分析和工具调用、准备最终回答前，运行 \`codex-usage turn --active --json\`。
3. 在最终回答末尾列出当前回合截至最终回答生成前的：总 token、输入、缓存输入、缓存外输入、输出、推理输出、API 等价成本、上下文剩余量。
4. 如存在尚未报告的上一回合完整数据，同时补充上一回合数据。
5. 不得估算或编造数据，也不得把生成最终回答前的数据称为当前回合完整用量。
6. 注明 API 等价成本不代表 ChatGPT 套餐实际账单。
7. 如果命令失败，写明：\`Token 用量：codex-usage 当前无法读取数据\`。
${REPORTING_PROMPT_END}`;

const USAGE = `Usage:
  codex-usage summary [--json] [--home-dir <dir>]
  codex-usage json [--home-dir <dir>]
  codex-usage turn [--session <id>] [--active] [--json] [--home-dir <dir>]
  codex-usage hook <notify-json> [--home-dir <dir>]
  codex-usage setup-reporting [--home-dir <dir>] [--check]
  codex-usage dashboard [--host <host>] [--port <port>] [--home-dir <dir>]
  codex-usage -d [--host <host>] [--port <port>] [--home-dir <dir>]
  codex-usage gateway [--host <host>] [--port <port>] [--home-dir <dir>] [--memory-mb <mb>]
  codex-usage restart [--host <host>] [--port <port>] [--home-dir <dir>] [--memory-mb <mb>]
  codex-usage run [--host <host>] [--port <port>] [--home-dir <dir>]
  codex-usage stop`;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function splitCommand(argv, defaultCommand = "summary") {
  if (argv[0] === "-d") {
    return { command: "dashboard", args: argv.slice(1) };
  }
  if (argv[0] && !argv[0].startsWith("-")) {
    return { command: argv[0], args: argv.slice(1) };
  }
  return { command: defaultCommand, args: argv };
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readOption(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function reportOptions(args) {
  const homeDir = readOption(args, "--home-dir");
  return homeDir ? { homeDir } : {};
}

function reportingAgentsPath(args) {
  const homeDir = readOption(args, "--home-dir");
  return path.join(homeDir || path.join(homedir(), ".codex"), "AGENTS.md");
}

function upsertManagedBlock(body, block) {
  const start = body.indexOf(REPORTING_PROMPT_START);
  const end = body.indexOf(REPORTING_PROMPT_END);
  if (start !== -1 && end !== -1 && end >= start) {
    return `${body.slice(0, start)}${block}${body.slice(end + REPORTING_PROMPT_END.length)}`;
  }
  const legacyStart = body.search(/^# Codex Usage Reporting\s*$/m);
  if (
    legacyStart !== -1
    && body.includes("codex-usage turn --json")
    && body.includes("codex-usage turn --active --json")
  ) {
    const nextHeading = body.indexOf("\n# ", legacyStart + 1);
    const legacyEnd = nextHeading === -1 ? body.length : nextHeading + 1;
    return `${body.slice(0, legacyStart)}${block}\n${body.slice(legacyEnd)}`;
  }
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

async function setupReporting(args) {
  const agentsPath = reportingAgentsPath(args);
  let current = "";
  try {
    current = await readFile(agentsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const expected = upsertManagedBlock(current, REPORTING_PROMPT);
  const configured = current === expected;
  if (hasFlag(args, "--check")) {
    console.log(configured ? `Usage reporting prompt is configured: ${agentsPath}` : `Usage reporting prompt needs setup: ${agentsPath}`);
    if (!configured) {
      process.exitCode = 1;
    }
    return;
  }

  await mkdir(path.dirname(agentsPath), { recursive: true });
  if (!configured) {
    await writeFile(agentsPath, expected);
  }
  console.log(`${configured ? "Usage reporting prompt already configured" : "Usage reporting prompt installed"}: ${agentsPath}`);
}

function stateFilePath(args) {
  return readOption(args, "--state-file", process.env.CODEX_USAGE_STATE_FILE || DEFAULT_STATE_FILE);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return number;
}

function formatUrl(host, port) {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

function withoutOption(args, name) {
  const nextArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    nextArgs.push(args[index]);
  }
  return nextArgs;
}

function invokedAsCud() {
  return path.basename(process.argv[1] || "") === "cud";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

async function waitForRegisteredService(filePath, pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const service = (await readServices(filePath)).find((entry) => entry.pid === pid);
    if (service && isProcessRunning(pid)) {
      return service;
    }
    if (!isProcessRunning(pid)) {
      throw new Error("Gateway service exited before it was ready.");
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for gateway service to start.");
}

async function readServices(filePath) {
  try {
    const body = await readFile(filePath, "utf8");
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.services)) {
      return parsed.services;
    }
    return [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeServices(filePath, services) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ services }, null, 2));
}

async function withServicesLock(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  let deadline = Date.now() + SERVICE_LOCK_WAIT_MS;

  await mkdir(path.dirname(filePath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      let isStale = false;
      try {
        const info = await stat(lockPath);
        isStale = Date.now() - info.mtimeMs > SERVICE_LOCK_STALE_MS;
      } catch (statError) {
        if (statError.code !== "ENOENT") {
          throw statError;
        }
      }

      if (isStale || Date.now() > deadline) {
        await rm(lockPath, { recursive: true, force: true });
        deadline = Date.now() + SERVICE_LOCK_WAIT_MS;
        continue;
      }
      await sleep(25);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeService(filePath, pid) {
  await withServicesLock(filePath, async () => {
    const services = await readServices(filePath);
    const nextServices = services.filter((service) => service.pid !== pid);
    if (nextServices.length === 0) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }
    await writeServices(filePath, nextServices);
  });
}

async function registerService(filePath, service) {
  await withServicesLock(filePath, async () => {
    const services = await readServices(filePath);
    const liveServices = services.filter((entry) => entry.pid && isProcessRunning(entry.pid));
    const nextServices = liveServices.filter((entry) => entry.pid !== service.pid);
    nextServices.push(service);
    await writeServices(filePath, nextServices);
  });
}

async function runningServices(filePath) {
  return (await readServices(filePath)).filter(
    (service) => service.pid && isProcessRunning(service.pid) && service.url,
  );
}

function printHuman(summary) {
  console.log(`Total tokens: ${formatNumber(summary.totals.total)}`);
  console.log(`Input tokens: ${formatNumber(summary.totals.input)}`);
  console.log(`Cached input: ${formatNumber(summary.totals.cached)}`);
  console.log(`Output tokens: ${formatNumber(summary.totals.output)}`);
  console.log(`Reasoning output: ${formatNumber(summary.totals.reasoning)}`);
  console.log(`Sessions: ${formatNumber(summary.sessionCount)}`);
  console.log("");
  console.log("By channel:");
  for (const channel of summary.channels) {
    console.log(`- ${channel.name}: ${formatNumber(channel.total.total)}`);
  }
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function printTurn(turn) {
  console.log(`Turn: ${turn.turnId}`);
  console.log(`Total tokens: ${formatNumber(turn.usage.total)}`);
  console.log(`Input: ${formatNumber(turn.usage.input)}`);
  console.log(`Cached input: ${formatNumber(turn.usage.cached)}`);
  console.log(`Uncached input: ${formatNumber(turn.cacheMissInput)}`);
  console.log(`Output: ${formatNumber(turn.usage.output)}`);
  console.log(`Reasoning output: ${formatNumber(turn.usage.reasoning)}`);
  console.log(`Cache hit rate: ${formatPercent(turn.cacheHitRate)}`);
  if (turn.cost?.available) {
    console.log(`API-equivalent cost: $${turn.cost.total.toFixed(6)}`);
  } else {
    console.log(`API-equivalent cost: unavailable for model ${turn.model || "unknown"}`);
  }
  if (turn.context) {
    console.log(
      `Context remaining: ${formatNumber(turn.context.remaining)} / ${formatNumber(turn.context.window)} (${turn.context.percentRemaining.toFixed(1)}%)`,
    );
  }
  if (turn.compactionCount > 0) {
    console.log(`Context compactions: ${formatNumber(turn.compactionCount)}`);
  }
}

async function findSessionFile(args, sessionId) {
  const options = reportOptions(args);
  const homes = await discoverCodexHomes(options);
  let newest = null;
  for (const home of homes) {
    for (const filePath of await discoverSessionFiles(home.path)) {
      if (sessionId && !path.basename(filePath).includes(sessionId)) {
        continue;
      }
      const info = await stat(filePath);
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { filePath, home, mtimeMs: info.mtimeMs };
      }
    }
  }
  return newest;
}

function selectTurn(turns, { active = false, turnId } = {}) {
  if (turnId) {
    return turns.findLast((turn) => turn.turnId === turnId) || null;
  }
  if (active) {
    return turns.at(-1) || null;
  }
  return turns.findLast((turn) => turn.status === "completed") || turns.at(-1) || null;
}

async function latestTurn(args, explicitSessionId, explicitTurnId) {
  const sessionId = explicitSessionId || readOption(args, "--session");
  const session = await findSessionFile(args, sessionId);
  if (!session) {
    throw new Error(sessionId ? `Session not found: ${sessionId}` : "No Codex session found.");
  }
  const turns = await parseSessionTurns(session.filePath, session.home);
  const turn = selectTurn(turns, {
    active: hasFlag(args, "--active"),
    turnId: explicitTurnId,
  });
  if (!turn) {
    const target = explicitTurnId ? `turn ${explicitTurnId}` : "a completed or active turn";
    throw new Error(`Could not find ${target} in session ${sessionId || path.basename(session.filePath)}.`);
  }
  return turn;
}

async function printLatestTurn(args) {
  const turn = await latestTurn(args);
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(turn, null, 2));
  } else {
    printTurn(turn);
  }
}

async function handleHook(args) {
  const payloadArg = args.find((arg) => arg.trim().startsWith("{"));
  const payload = payloadArg ? JSON.parse(payloadArg) : {};
  const sessionId = payload["thread-id"] || payload.thread_id || payload.sessionId;
  const turnId = payload["turn-id"] || payload.turn_id || payload.turnId;
  const turn = await latestTurn(args, sessionId, turnId);
  const snapshotPath = path.join(homedir(), ".codex-usage", "latest-turn.json");
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(
    snapshotPath,
    JSON.stringify({ capturedAt: new Date().toISOString(), hook: payload, turn }, null, 2),
  );
  printTurn(turn);
}

async function printSummary(command, args) {
  if (command === "json") {
    const report = await buildUsageReport(reportOptions(args));
    const summary = summarizeUsage(report, { preset: "all", bucket: "month" });
    console.log(JSON.stringify({ report, summary }, null, 2));
    return;
  }

  // 摘要命令复用磁盘索引，避免历史事件常驻内存。
  const store = new UsageStore(reportOptions(args));
  try {
    await store.sync();
    const summary = store.summarize({ preset: "all", bucket: "month" });
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify({ metadata: store.metadata(), summary }, null, 2));
      return;
    }
    printHuman(summary);
  } finally {
    store.close();
  }
}

function runServer(args) {
  const host = readOption(args, "--host", process.env.HOST || DEFAULT_HOST);
  const port = parsePort(readOption(args, "--port", process.env.PORT || String(DEFAULT_PORT)));
  const stateFile = stateFilePath(args);
  const server = createUsageServer(reportOptions(args));
  let shuttingDown = false;

  server.listen(port, host, async () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = formatUrl(host, actualPort);
    try {
      await registerService(stateFile, {
        pid: process.pid,
        host,
        port: actualPort,
        url,
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        nodeExecArgv: process.execArgv,
        startedAt: new Date().toISOString(),
      });
      console.log(`Codex Usage dashboard: ${url}`);
    } catch (error) {
      console.error(error.stack || error.message);
      server.close(() => {
        process.exit(1);
      });
    }
  });

  server.on("error", async (error) => {
    await removeService(stateFile, process.pid);
    console.error(error.message);
    process.exitCode = 1;
  });

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await removeService(stateFile, process.pid);
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

async function startGateway(args, { announce = true } = {}) {
  const stateFile = stateFilePath(args);
  const cliPath = fileURLToPath(import.meta.url);
  const memoryMb = parsePositiveInteger(
    readOption(args, "--memory-mb", process.env.CODEX_USAGE_MEMORY_MB || String(DEFAULT_GATEWAY_MEMORY_MB)),
    "--memory-mb",
  );
  const runArgs = withoutOption(args, "--memory-mb");
  const child = spawn(process.execPath, [`--max-old-space-size=${memoryMb}`, cliPath, "run", ...runArgs], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });

  child.unref();

  const service = await waitForRegisteredService(stateFile, child.pid);
  if (announce) {
    console.log(`Codex Usage gateway started: ${service.url} (pid ${service.pid})`);
  }
  return service;
}

function openUrl(url) {
  const currentPlatform = platform();
  const opener =
    currentPlatform === "darwin"
      ? { command: "open", args: [url] }
      : currentPlatform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    console.error(`Unable to open dashboard: ${error.message}`);
  });
  child.unref();
}

async function openDashboard(args) {
  const stateFile = stateFilePath(args);
  const services = await runningServices(stateFile);
  const service = services[0] || (await startGateway(args, { announce: false }));
  if (!hasFlag(args, "--no-open") && process.env.CODEX_USAGE_OPEN !== "0") {
    openUrl(service.url);
  }
  console.log(`Codex Usage dashboard: ${service.url}`);
}

async function stopRunningServices(args, { announce = true } = {}) {
  const stateFile = stateFilePath(args);
  const services = await readServices(stateFile);
  const runningServices = services.filter(
    (service) => service.pid && service.pid !== process.pid && isProcessRunning(service.pid),
  );

  if (runningServices.length === 0) {
    await writeServices(stateFile, []);
    if (announce) {
      console.log("No running Codex Usage services found.");
    }
    return { stoppedServices: [], stillRunningServices: [] };
  }

  for (const service of runningServices) {
    process.kill(service.pid, "SIGTERM");
  }

  const stoppedServices = [];
  const stillRunningServices = [];
  for (const service of runningServices) {
    if (await waitForProcessExit(service.pid)) {
      stoppedServices.push(service);
    } else {
      stillRunningServices.push(service);
    }
  }

  await withServicesLock(stateFile, async () => {
    const liveServices = (await readServices(stateFile)).filter(
      (service) => service.pid && isProcessRunning(service.pid),
    );
    await writeServices(stateFile, liveServices);
  });

  if (stillRunningServices.length > 0) {
    if (announce) {
      console.error(
        `Stopped ${stoppedServices.length} Codex Usage service(s), ${stillRunningServices.length} still running.`,
      );
    }
    return { stoppedServices, stillRunningServices };
  }

  if (announce) {
    console.log(`Stopped ${stoppedServices.length} Codex Usage service(s).`);
  }
  return { stoppedServices, stillRunningServices };
}

async function stopServers(args) {
  const { stillRunningServices } = await stopRunningServices(args);
  if (stillRunningServices.length > 0) {
    process.exitCode = 1;
  }
}

async function restartGateway(args) {
  const { stillRunningServices } = await stopRunningServices(args);
  if (stillRunningServices.length > 0) {
    process.exitCode = 1;
    return;
  }

  const service = await startGateway(args, { announce: false });
  console.log(`Codex Usage gateway restarted: ${service.url} (pid ${service.pid})`);
}

async function main() {
  const { command, args } = splitCommand(process.argv.slice(2), invokedAsCud() ? "dashboard" : "summary");

  if (command === "help" || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(USAGE);
    return;
  }

  if (command === "run" || command === "serve") {
    runServer(args);
    return;
  }

  if (command === "gateway") {
    await startGateway(args);
    return;
  }

  if (command === "restart") {
    await restartGateway(args);
    return;
  }

  if (command === "dashboard") {
    await openDashboard(args);
    return;
  }

  if (command === "stop") {
    await stopServers(args);
    return;
  }

  if (command === "turn") {
    await printLatestTurn(args);
    return;
  }

  if (command === "hook") {
    await handleHook(args);
    return;
  }

  if (command === "setup-reporting") {
    await setupReporting(args);
    return;
  }

  if (command === "summary" || command === "json") {
    await printSummary(command, args);
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
