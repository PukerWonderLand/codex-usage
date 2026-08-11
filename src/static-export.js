import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildUsageReport } from "./usage-core.js";
import { parseSessionTurns } from "./usage-core.js";
import { sumCosts } from "./pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function safeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function publicStaticReport(report, sessionId) {
  if (!sessionId) {
    return report;
  }
  return {
    ...report,
    homes: (report.homes || []).map(({ path: _path, ...home }) => home),
    sessions: (report.sessions || [])
      .filter((session) => session.id === sessionId)
      .map(({ filePath: _filePath, homePath: _homePath, ...session }) => session),
    events: (report.events || []).filter((event) => event.sessionId === sessionId),
  };
}

export function renderStaticDashboardHtml(report, options = {}) {
  const indexHtml = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const styles = readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");
  const app = readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  return indexHtml
    .replace('<link rel="stylesheet" href="/styles.css" />', `<style>\n${styles}\n</style>`)
    .replace(
      '<script src="/app.js" type="module"></script>',
      `<script>window.__CODEX_USAGE_REPORT__ = ${safeScriptJson(report)};\nwindow.__CODEX_USAGE_TURN_DATA__ = ${safeScriptJson(options.turnData || null)};\nwindow.__CODEX_USAGE_DEFAULT_SESSION_ID__ = ${safeScriptJson(options.sessionId || "")};</script>\n<script type="module">\n${app}\n</script>`,
    );
}

export async function exportStaticDashboard(options = {}) {
  const outFile = options.outFile || path.join(ROOT_DIR, "dist", "codex-usage.html");
  const report = options.report || (await buildUsageReport(options));
  const session = options.sessionId
    ? report.sessions.find((candidate) => candidate.id === options.sessionId)
    : null;
  if (options.sessionId && !session) {
    throw new Error(`Session not found: ${options.sessionId}`);
  }
  let turnData = options.turnData || null;
  if (session && !turnData) {
    const turns = await parseSessionTurns(session.filePath, {
      homeId: session.homeId,
      homeLabel: session.homeLabel,
      homePath: session.homePath,
    });
    turnData = {
      sessionId: session.id,
      turns,
      summary: {
        turnCount: turns.length,
        completedTurnCount: turns.filter((turn) => turn.status === "completed").length,
        cost: sumCosts(turns.flatMap((turn) => turn.requests.map((request) => request.cost))),
        latestContext: turns.at(-1)?.context || null,
        compactionCount: turns.reduce((sum, turn) => sum + turn.compactionCount, 0),
      },
    };
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    renderStaticDashboardHtml(publicStaticReport(report, options.sessionId), {
      sessionId: options.sessionId,
      turnData,
    }),
  );
  return outFile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outArgIndex = process.argv.indexOf("--out");
  const outFile = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : undefined;
  const sessionArgIndex = process.argv.indexOf("--session");
  const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;
  exportStaticDashboard({ outFile, sessionId })
    .then((file) => {
      console.log(file);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
