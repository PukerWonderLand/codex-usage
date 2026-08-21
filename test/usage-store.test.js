import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { UsageStore } from "../src/usage-store.js";
import { buildUsageIndex, summarizeUsageIndex } from "../src/usage-core.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function tokenRow(timestamp, total, input, cached, output, reasoning) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
      },
    },
  };
}

async function makeStoreFixture() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-store-"));
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "12");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-07-12T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "store-session", source: "cli", originator: "codex-tui", cwd: "/work/store" },
      },
      tokenRow("2026-07-12T01:01:00.000Z", 123, 100, 20, 23, 5),
    ]),
  );
  return {
    homeDir,
    sessionFile,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  };
}

test("UsageStore 首次同步并只重建变化文件", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    const first = await store.sync();
    const firstMetadata = store.metadata();
    const firstSummary = store.summarize({ preset: "all", bucket: "day" });

    assert.equal(first.updatedFileCount, 1);
    assert.equal(firstMetadata.eventCount, 1);
    assert.equal(firstMetadata.sessionCount, 1);
    assert.equal(firstSummary.totals.total, 123);

    const baseline = new DatabaseSync(databaseFile);
    const firstEventId = baseline.prepare("SELECT id FROM events").get().id;
    baseline.prepare("UPDATE source_files SET parser_state = ''").run();
    baseline.close();

    await appendFile(sessionFile, JSON.stringify(tokenRow("2026-07-12T01:02:00.000Z", 200, 160, 30, 40, 7)) + "\n");

    const refreshed = await store.sync();
    const refreshedSummary = store.summarize({ preset: "all", bucket: "day" });
    const unchanged = await store.sync();

    assert.equal(refreshed.updatedFileCount, 1);
    assert.equal(refreshedSummary.eventCount, 2);
    assert.equal(refreshedSummary.totals.total, 200);
    assert.equal(unchanged.updatedFileCount, 0);
    const verification = new DatabaseSync(databaseFile, { readOnly: true });
    const eventIds = verification.prepare("SELECT id FROM events ORDER BY id").all().map((row) => row.id);
    const source = verification.prepare("SELECT size, indexed_offset, parser_state FROM source_files").get();
    verification.close();
    assert.equal(eventIds[0], firstEventId);
    assert.equal(eventIds.length, 2);
    assert.equal(Number(source.indexed_offset), Number(source.size));
    assert.ok(source.parser_state.length > 0);
  } finally {
    store.close();
  }
});

test("UsageStore 汇总结果与内存索引保持一致", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const index = await buildUsageIndex({ homeDir });
    const filtersList = [
      { preset: "all", bucket: "day" },
      { preset: "today", bucket: "hour", now: "2026-07-12T12:00:00.000Z" },
    ];

    for (const filters of filtersList) {
      const actual = store.summarize(filters);
      const expected = summarizeUsageIndex(index, filters);
      assert.deepEqual({ ...actual, generatedAt: "" }, { ...expected, generatedAt: "" });
    }
  } finally {
    store.close();
  }
});

test("UsageStore 对跨小时边界的最近 24 小时保持精确", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeStoreFixture();
  await appendFile(sessionFile, JSON.stringify(tokenRow("2026-07-12T01:40:00.000Z", 200, 160, 30, 40, 7)) + "\n");
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const filters = {
      preset: "recent",
      recentValue: "1天",
      bucket: "hour",
      now: "2026-07-13T01:30:00.000Z",
    };
    const index = await buildUsageIndex({ homeDir });
    const actual = store.summarize(filters);
    const expected = summarizeUsageIndex(index, filters);

    assert.deepEqual({ ...actual, generatedAt: "" }, { ...expected, generatedAt: "" });
    assert.equal(actual.eventCount, 1);
    assert.equal(actual.totals.total, 77);
  } finally {
    store.close();
  }
});

test("UsageStore 使用 Codex 状态库中的会话名称和中文标题", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const codexHome = path.join(homeDir, ".codex");
  const state = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT NOT NULL,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO threads (id, name, title) VALUES
      ('store-session', '我的自定义名称', '自动生成的中文标题');
  `);
  state.close();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const [session] = store.listSessions();
    assert.equal(session.name, "我的自定义名称");
    assert.equal(session.title, "自动生成的中文标题");
  } finally {
    store.close();
  }
});

test("UsageStore keeps an incomplete JSONL tail pending until the line is complete", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });
  const nextLine = JSON.stringify(tokenRow("2026-07-12T01:02:00.000Z", 200, 160, 30, 40, 7));
  const split = Math.floor(nextLine.length / 2);

  try {
    await store.sync();
    await appendFile(sessionFile, nextLine.slice(0, split));
    await store.sync();
    const pending = store.summarize({ preset: "all", bucket: "day" });
    assert.equal(pending.eventCount, 1);
    assert.equal(pending.totals.total, 123);

    await appendFile(sessionFile, nextLine.slice(split) + "\n");
    await store.sync();
    const completed = store.summarize({ preset: "all", bucket: "day" });
    assert.equal(completed.eventCount, 2);
    assert.equal(completed.totals.total, 200);
  } finally {
    store.close();
  }
});

test("UsageStore limits oversized state database titles in the sessions response", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const codexHome = path.join(homeDir, ".codex");
  const state = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT NOT NULL,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT ''
    );
  `);
  state.prepare("INSERT INTO threads (id, name, title) VALUES (?, ?, ?)")
    .run("store-session", "", `oversized ${"title ".repeat(1000)}`);
  state.close();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const [session] = store.listSessions();
    assert.equal(session.title.length, 240);
    assert.ok(!session.title.includes("\n"));
  } finally {
    store.close();
  }
});

test("UsageStore 在 SQLite 中按 session 汇总而不构建全量报告", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const secondDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "13");
  await mkdir(secondDir, { recursive: true });
  await writeFile(
    path.join(secondDir, "rollout-second.jsonl"),
    jsonl([
      {
        timestamp: "2026-07-13T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "second-session", source: "cli", originator: "codex-tui", cwd: "/work/second" },
      },
      tokenRow("2026-07-13T01:01:00.000Z", 456, 400, 100, 56, 8),
    ]),
  );
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const selected = store.summarize({ preset: "all", bucket: "day", sessionId: "store-session" });
    assert.equal(selected.sessionCount, 1);
    assert.equal(selected.totals.total, 123);
    assert.equal(selected.timeline.reduce((sum, row) => sum + row.total.total, 0), 123);
    assert.deepEqual(selected.projects.map((row) => row.name), ["/work/store"]);
  } finally {
    store.close();
  }
});
