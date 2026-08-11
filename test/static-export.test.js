import assert from "node:assert/strict";
import test from "node:test";

import { exportStaticDashboard, renderStaticDashboardHtml } from "../src/static-export.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("renderStaticDashboardHtml embeds usage data and app assets", () => {
  const html = renderStaticDashboardHtml({
    generatedAt: "2026-05-25T00:00:00.000Z",
    homes: [{ label: "Main Codex", path: "/tmp/.codex", kind: "main" }],
    sessions: [],
    events: [
      {
        timestamp: "2026-05-25T00:00:00.000Z",
        sessionId: "s1",
        channel: "CLI",
        cwd: "/work",
        model: "gpt-5.5",
        total: { total: 10, input: 8, cached: 1, output: 2, reasoning: 0 },
      },
    ],
    warnings: [],
  });

  assert.match(html, /Codex Usage/);
  assert.match(html, /window.__CODEX_USAGE_REPORT__/);
  assert.match(html, /CLI/);
  assert.match(html, /timelineChart/);
  assert.match(html, /id="usageTooltip"/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /themeToggle/);
  assert.match(html, /data-theme-option="dark"/);
  assert.match(html, /id="importButton"/);
  assert.match(html, /id="addImportButton"/);
  assert.match(html, /id="importDialog"/);
  assert.match(html, /id="importPath"/);
  assert.match(html, /id="pickImportDirectoryButton"/);
  assert.match(html, /id="comparisonSummary"/);
  assert.match(html, /id="projectSearch"/);
  assert.match(html, /id="modelSearch"/);
  assert.match(html, /id="timelineDetails"/);
});

test("renderStaticDashboardHtml embeds a default session and its turn details", () => {
  const html = renderStaticDashboardHtml({ sessions: [], events: [], warnings: [] }, {
    sessionId: "session-static-1",
    turnData: { sessionId: "session-static-1", turns: [{ turnId: "turn-static-1" }], summary: {} },
  });

  assert.match(html, /__CODEX_USAGE_DEFAULT_SESSION_ID__ = "session-static-1"/);
  assert.match(html, /__CODEX_USAGE_TURN_DATA__/);
  assert.match(html, /turn-static-1/);
});

test("exportStaticDashboard scopes a public snapshot and removes local session paths", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "codex-static-"));
  const outFile = path.join(outputDir, "index.html");
  await exportStaticDashboard({
    outFile,
    sessionId: "selected",
    turnData: { sessionId: "selected", turns: [], summary: {} },
    report: {
      homes: [{ id: "home", label: "Main", path: "/private/home" }],
      sessions: [
        { id: "selected", filePath: "/private/selected.jsonl", homePath: "/private/home" },
        { id: "other", filePath: "/private/other.jsonl", homePath: "/private/home" },
      ],
      events: [{ sessionId: "selected" }, { sessionId: "other" }],
      warnings: [],
    },
  });
  const html = await readFile(outFile, "utf8");

  assert.match(html, /selected/);
  assert.doesNotMatch(html, /private\/selected/);
  assert.doesNotMatch(html, /private\/other/);
  assert.doesNotMatch(html, /sessionId":"other/);
});
