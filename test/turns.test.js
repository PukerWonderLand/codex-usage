import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { contextWindowSnapshot, parseSessionTurns } from "../src/usage-core.js";

test("context window matches the Codex 12K-baseline status calculation", () => {
  const context = contextWindowSnapshot({ total: 133_186 }, 258_400);
  assert.equal(context.remaining, 125_214);
  assert.equal(context.percentRemaining, 51);
});

test("parseSessionTurns groups request usage, cache misses, cost, and context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-turns-"));
  const file = path.join(root, "sessions", "rollout.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const rows = [
    { timestamp: "2026-08-11T00:00:00Z", type: "session_meta", payload: { id: "s1", source: "cli", originator: "codex-tui", cwd: "/work" } },
    { timestamp: "2026-08-11T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { timestamp: "2026-08-11T00:00:02Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    { timestamp: "2026-08-11T00:00:03Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 1010, input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 }, last_token_usage: { total_tokens: 1010, input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 }, model_context_window: 2000 } } },
    { timestamp: "2026-08-11T00:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 2000 } },
  ];
  await writeFile(file, rows.map(JSON.stringify).join("\n") + "\n");
  const turns = await parseSessionTurns(file, { label: "Main Codex" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, "t1");
  assert.equal(turns[0].usage.total, 1010);
  assert.equal(turns[0].cacheMissInput, 200);
  assert.equal(turns[0].cacheHitRate, 0.8);
  assert.equal(turns[0].context.remaining, 990);
  assert.equal(turns[0].cost.available, true);
});
