import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard refreshes only on demand", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /visibilitychange/);
  assert.doesNotMatch(source, /checkForUpdates/);
  assert.match(source, /refreshButton.*loadUsage\(\)/);
  assert.doesNotMatch(source, /refreshButton.*force: true/);
  assert.doesNotMatch(source, /params\.set\("detail", "full"\)/);
  assert.match(source, /const usagePromise = fetch/);
  assert.match(source, /const turnsPromise = state\.sessionId/);
});
