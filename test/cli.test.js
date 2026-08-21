import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function makeFixtureHome() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-cli-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "rollout-cli-run-1.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "cli-run-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      {
        timestamp: "2026-05-01T02:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
      {
        timestamp: "2026-05-01T02:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-cli-1" },
      },
      {
        timestamp: "2026-05-01T02:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 258400,
            total_token_usage: {
              total_tokens: 77,
              input_tokens: 60,
              cached_input_tokens: 10,
              output_tokens: 17,
              reasoning_output_tokens: 3,
            },
            last_token_usage: {
              total_tokens: 77,
              input_tokens: 60,
              cached_input_tokens: 10,
              output_tokens: 17,
              reasoning_output_tokens: 3,
            },
          },
        },
      },
      {
        timestamp: "2026-05-01T02:02:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-cli-1" },
      },
      {
        timestamp: "2026-05-01T02:03:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-cli-active" },
      },
    ]),
  );
  return fakeHome;
}

function waitForServerUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for server URL. Output: ${output}`));
    }, 5000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before ready: ${code}. Output: ${output}`));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function isolatedEnv(homeDir) {
  // Keep CLI integration tests from reading the developer's real ~/.codex-usage state.
  return { ...process.env, HOME: homeDir };
}

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`cli exited with ${code}: ${output}${errorOutput}`));
      }
    });
  });
}

test("cli run starts a local usage server", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const child = spawn(
    process.execPath,
    [
      "src/cli.js",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: isolatedEnv(homeDir),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const url = await waitForServerUrl(child);
    const usage = await fetch(`${url}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }
});

test("cli summary --json returns lightweight summary metadata without full report", async () => {
  const homeDir = await makeFixtureHome();

  const output = await runCli(["summary", "--json", "--home-dir", homeDir], isolatedEnv(homeDir));
  const parsed = JSON.parse(output);

  assert.equal(parsed.summary.totals.total, 77);
  assert.equal(parsed.metadata.eventCount, 1);
  assert.equal(parsed.report, undefined);
  assert.ok((await stat(path.join(homeDir, ".codex-usage", "usage-index.sqlite"))).size > 0);
});

test("cli turn defaults to the latest completed turn when a new turn is active", async () => {
  const homeDir = await makeFixtureHome();
  const output = await runCli(["turn", "--home-dir", homeDir], isolatedEnv(homeDir));

  assert.match(output, /Turn: turn-cli-1/);
  assert.match(output, /Uncached input: 50/);
  assert.match(output, /API-equivalent cost: \$0\.000765/);
  assert.match(output, /Context remaining: 258,323 \/ 258,400/);
});

test("cli turn --active explicitly prints the current active turn", async () => {
  const homeDir = await makeFixtureHome();
  const output = await runCli(["turn", "--active", "--home-dir", homeDir], isolatedEnv(homeDir));

  assert.match(output, /Turn: turn-cli-active/);
  assert.match(output, /Total tokens: 0/);
});

test("cli hook stores the latest turn snapshot for a Codex notify callback", async () => {
  const homeDir = await makeFixtureHome();
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "cli-run-1",
    "turn-id": "turn-cli-1",
  });
  await runCli(["hook", payload, "--home-dir", homeDir], isolatedEnv(homeDir));

  const snapshot = JSON.parse(
    await readFile(path.join(homeDir, ".codex-usage", "latest-turn.json"), "utf8"),
  );
  assert.equal(snapshot.turn.turnId, "turn-cli-1");
  assert.equal(snapshot.turn.cacheMissInput, 50);
});

test("cli setup-reporting installs an idempotent managed AGENTS.md block", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-reporting-"));
  const agentsPath = path.join(homeDir, "AGENTS.md");
  await writeFile(agentsPath, "# Existing instructions\n\nKeep this text.\n");

  const first = await runCli(["setup-reporting", "--home-dir", homeDir], isolatedEnv(homeDir));
  const firstBody = await readFile(agentsPath, "utf8");
  const second = await runCli(["setup-reporting", "--home-dir", homeDir], isolatedEnv(homeDir));
  const secondBody = await readFile(agentsPath, "utf8");
  const check = await runCli(["setup-reporting", "--check", "--home-dir", homeDir], isolatedEnv(homeDir));

  assert.match(first, /prompt installed/);
  assert.match(second, /already configured/);
  assert.match(check, /is configured/);
  assert.match(firstBody, /Keep this text\./);
  assert.match(firstBody, /codex-usage:reporting:start/);
  assert.match(firstBody, /codex-usage turn --active --json/);
  assert.equal(secondBody, firstBody);
  assert.equal((firstBody.match(/codex-usage:reporting:start/g) || []).length, 1);
});

test("cli setup-reporting migrates the legacy unmarked reporting prompt", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-reporting-legacy-"));
  const agentsPath = path.join(homeDir, "AGENTS.md");
  await writeFile(
    agentsPath,
    "# Codex Usage Reporting\n\nRun `codex-usage turn --json`, then `codex-usage turn --active --json`.\n",
  );

  await runCli(["setup-reporting", "--home-dir", homeDir], isolatedEnv(homeDir));
  const body = await readFile(agentsPath, "utf8");

  assert.equal((body.match(/^# Codex Usage Reporting$/gm) || []).length, 1);
  assert.equal((body.match(/codex-usage:reporting:start/g) || []).length, 1);
});

test("cli gateway starts a background usage server and returns", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  let url = "";

  try {
    const output = await runCli([
      "gateway",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ], isolatedEnv(homeDir));
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, output);
    url = match[0];

    const usage = await fetch(`${url}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    await runCli(["stop", "--state-file", stateFile], isolatedEnv(homeDir));
  }
});

test("cli gateway uses a safer default heap budget for dashboard refreshes", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    await runCli([
      "gateway",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ], isolatedEnv(homeDir));

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const service = state.services[0];
    assert.ok(service, "expected gateway service to be registered");
    assert.ok(
      service.nodeExecArgv.includes("--max-old-space-size=256"),
      `expected gateway Node args to include a 256MB heap budget, got ${JSON.stringify(service.nodeExecArgv)}`,
    );
  } finally {
    await runCli(["stop", "--state-file", stateFile], isolatedEnv(homeDir));
  }
});

test("cli restart stops existing services and starts a new gateway", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    const startOutput = await runCli([
      "gateway",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ], isolatedEnv(homeDir));
    const startMatch = startOutput.match(/(http:\/\/127\.0\.0\.1:\d+).*pid (\d+)/);
    assert.ok(startMatch, startOutput);
    const firstPid = Number(startMatch[2]);
    assert.equal(isProcessRunning(firstPid), true);

    const restartOutput = await runCli([
      "restart",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ], isolatedEnv(homeDir));
    assert.match(restartOutput, /Stopped 1 Codex Usage service/);
    const restartMatch = restartOutput.match(/Codex Usage gateway restarted: (http:\/\/127\.0\.0\.1:\d+) \(pid (\d+)\)/);
    assert.ok(restartMatch, restartOutput);
    const restartUrl = restartMatch[1];
    const restartPid = Number(restartMatch[2]);

    assert.notEqual(restartPid, firstPid);
    assert.equal(isProcessRunning(firstPid), false);
    const usage = await fetch(`${restartUrl}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(
      state.services.map((service) => service.pid),
      [restartPid],
    );
  } finally {
    await runCli(["stop", "--state-file", stateFile], isolatedEnv(homeDir));
  }
});

test("cli run recovers from a stale service lock", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const lockDir = `${stateFile}.lock`;
  await mkdir(lockDir, { recursive: true });
  const oldDate = new Date(Date.now() - 60_000);
  await utimes(lockDir, oldDate, oldDate);

  const child = spawn(
    process.execPath,
    [
      "src/cli.js",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: isolatedEnv(homeDir),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const url = await waitForServerUrl(child);
    const usage = await fetch(`${url}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }
});

test("cli dashboard starts a background service and prints the dashboard URL", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    const output = await runCli([
      "dashboard",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ], isolatedEnv(homeDir));
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, output);

    const usage = await fetch(`${match[0]}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    await runCli(["stop", "--state-file", stateFile], isolatedEnv(homeDir));
  }
});

test("cud command opens the dashboard by default", { skip: process.platform === "win32" }, async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const binDir = await mkdtemp(path.join(tmpdir(), "codex-cud-bin-"));
  const cudPath = path.join(binDir, "cud");
  await symlink(path.resolve(import.meta.dirname, "..", "src", "cli.js"), cudPath);
  await chmod(cudPath, 0o755);

  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cudPath,
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--home-dir",
        homeDir,
        "--state-file",
        stateFile,
      ], {
        env: isolatedEnv(homeDir),
      });
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        text += chunk.toString();
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(text);
        } else {
          reject(new Error(`cud exited with ${code}: ${text}`));
        }
      });
    });
    assert.match(output, /Codex Usage dashboard/);
    assert.match(output, /http:\/\/127\.0\.0\.1:(\d+)/);
  } finally {
    await runCli(["stop", "--state-file", stateFile], isolatedEnv(homeDir));
  }
});

test("codex-usage -d opens the dashboard", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    const output = await runCli([
      "-d",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ], isolatedEnv(homeDir));
    assert.match(output, /Codex Usage dashboard/);
    assert.match(output, /http:\/\/127\.0\.0\.1:(\d+)/);
  } finally {
    await runCli(["stop", "--state-file", stateFile], isolatedEnv(homeDir));
  }
});

test("cli stop terminates all running usage services from the state file", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      [
        "src/cli.js",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--home-dir",
        homeDir,
        "--state-file",
        stateFile,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: isolatedEnv(homeDir),
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  try {
    await Promise.all(children.map((child) => waitForServerUrl(child)));

    const stop = spawn(process.execPath, ["src/cli.js", "stop", "--state-file", stateFile], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: isolatedEnv(homeDir),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stopOutput = await new Promise((resolve, reject) => {
      let output = "";
      stop.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      stop.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      stop.on("exit", (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`stop exited with ${code}: ${output}`));
        }
      });
    });

    assert.match(stopOutput, /Stopped 2 Codex Usage service/);
    const exitCodes = await Promise.all(children.map((child) => waitForExit(child)));
    assert.deepEqual(exitCodes, process.platform === "win32" ? [1, 1] : [0, 0]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await waitForExit(child);
      }
    }
  }
});
