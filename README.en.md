# Codex Usage

[简体中文](README.md) | [English](README.en.md)

[Live static demo](https://pukerwonderland.github.io/codex-usage/)

[中文](README.md) | English

Codex Usage is a local-first token usage analytics tool for Codex. It reads official Codex session logs on your machine, aggregates usage from CLI, Codex Desktop, Codex Exec, JetBrains/PyCharm plugins, and other integrations, then presents the results through a CLI summary, a local web dashboard, a background gateway, static HTML export, and JSON APIs.

It helps you answer questions like: How many tokens did I use today? Which project consumed the most? How much usage came from CLI versus IDE plugins? How much was input, cached input, output, or reasoning output?

## Highlights

- Scans official Codex session logs locally; no external upload is required
- Tracks total tokens, input, cached input, output, reasoning output, and session count
- Shows per-session and native Codex-turn tokens, cache behavior, API-equivalent cost, and context headroom
- In server mode, reads Codex's local state database to show custom session names or generated titles while retaining a short session ID for verification
- Supports today, this week, this month, all time, and custom date ranges
- Shows time trends by hour, day, week, or month
- Breaks usage down by channel, project directory, model, and scanned home
- Provides CLI summaries, an interactive local dashboard, a background gateway, and static HTML snapshots
- Imports extra Codex homes or project logs generated at `.codex-usage/usage.jsonl`
- Uses a lightweight fingerprint check and only reparses logs when session files change
- Designed as a personal local dashboard for long-running Codex usage tracking

## Supported Sources

Codex Usage currently reads official Codex session logs from:

- Main Codex/CLI/App home: `~/.codex`
- JetBrains/PyCharm plugin homes: `~/Library/Caches/JetBrains/*/aia/codex`
- Extra Codex homes passed through the `CODEX_USAGE_HOMES` environment variable
- Project usage logs from imported project directories containing `.codex-usage/usage.jsonl`

Channels are classified as:

- `Codex Desktop`
- `Codex Exec`
- `CLI`
- `JetBrains PyCharm`
- `Codex OAuth`
- Other editor integrations when they cannot be classified more specifically

Requests made directly through the OpenAI API are not counted unless they are written to official Codex session logs.

## Requirements

Node.js `>=22.13` is required for the built-in SQLite index.

```bash
node --version
```

## Quick Start

```bash
git clone https://github.com/<your-name>/codex-usage.git
cd codex-usage
```

Print a CLI summary:

```bash
npm run summary
```

Start the local web dashboard:

```bash
npm run serve
```

Then open:

```text
http://127.0.0.1:3765
```

You can also choose another port:

```bash
PORT=4000 npm run serve
```

## CLI Usage

Run the local service in the foreground:

```bash
node src/cli.js run
```

To use `codex-usage` or `cud` on your machine, link the package from the project directory:

```bash
npm link
codex-usage dashboard
```

You can also open the dashboard with the short option:

```bash
codex-usage -d
```

`dashboard` reuses an existing registered background service. If no service is running, it starts a background gateway and opens the dashboard. The short command is also available:

```bash
cud
```

Start a background gateway:

```bash
codex-usage gateway
```

Restart the background gateway:

```bash
codex-usage restart
```

The dashboard and `summary` keep a lightweight index at `~/.codex-usage/usage-index.sqlite`. The first run builds it row by row. A growing Codex JSONL file then resumes after its persisted byte offset and consumes only complete appended lines; an individual file is rebuilt only when it is replaced or truncated. To rebuild from scratch, stop the service, remove that SQLite file, and start the gateway again.

Stop services registered by this tool:

```bash
codex-usage stop
```

Print JSON output:

```bash
node src/cli.js json
node src/cli.js summary --json
```

Inspect the latest turn or bind to a session:

```bash
codex-usage turn
codex-usage turn --session 019fefcd-2519-78c3-acb6-6ada3b090da7
codex-usage turn --json
```

Enable automatic usage reporting at the end of answers in every new Codex session:

```bash
codex-usage setup-reporting
codex-usage setup-reporting --check
```

This command creates or updates a marked, managed block in `~/.codex/AGENTS.md`. It is idempotent and preserves unrelated user instructions. Before the final answer is generated, only usage "as of answer generation" is available; the exact completed-turn value is captured by the hook and can be reported at the start of the next turn.

Export a single-file static dashboard for one session:

```bash
node src/static-export.js --out docs/index.html --session <session-id>
```

A session-scoped export keeps only that session's usage events and removes server-only local log paths, making it suitable for GitHub Pages.

Connect Codex's turn-complete callback in `~/.codex/config.toml`:

```toml
notify = ["codex-usage", "hook"]
```

The hook refreshes `~/.codex-usage/latest-turn.json` after every turn. Codex currently discards notify subprocess output, so an external utility cannot reliably inject text into the main TUI; use `codex-usage turn` or display the snapshot in a companion terminal.

Costs are **API-equivalent estimates**, not ChatGPT or Codex subscription charges. GPT-5.6 Sol pricing is versioned in `src/pricing.js`, including the official long-context threshold and multipliers. Context headroom follows the Codex `/status` calculation with its 12K baseline reserve. Requests also show uncached input, cache hit rate, and detected context compaction.

## Windows LAN Deployment

On Windows 10/11, an administrator PowerShell can install a current-user scheduled task, restart supervisor, Codex hook, and a Private/LocalSubnet firewall rule:

```powershell
.\scripts\windows\Install-CodexUsage.ps1 -WhatIf
.\scripts\windows\Install-CodexUsage.ps1
.\scripts\windows\Test-CodexUsageDeployment.ps1
```

The installer backs up the user-level `~/.codex/config.toml` and preserves an existing `notify` command. The task runs after the current user signs in. The LAN dashboard uses unencrypted HTTP, so keep it on a trusted Private network and never expose it directly to the internet.

See the [Windows LAN deployment guide](docs/windows-lan-deployment.en.md) for installation, remote acceptance, failure recovery, and rollback. Codex defines `notify` as a user-level command array that receives a JSON payload; see the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Dashboard

The web dashboard supports:

- Today, this week, this month, all time, and custom date ranges
- Hourly, daily, weekly, and monthly aggregation
- Total tokens, input, cached input, output, reasoning output, and session count
- Session selection, turn-level usage and cost, cache details, context headroom, and compaction count
- Channel breakdown
- Timeline chart
- Top 25 project directories
- Model breakdown
- Scanned home list
- Light and dark themes saved in local browser storage
- Directory imports from the top-right button or the scanned home panel

Server mode refreshes on demand and does not scan on a timer or when the window regains focus. Page loads and refresh-button clicks incrementally update only changed logs. Session changes use the SQLite index to open only the selected log. Turn details are cached by file size and modification time under `~/.codex-usage/turn-cache/`, so large unchanged sessions do not need to be reparsed.

## Directory Imports and Project Logs

The dashboard's `导入目录` button and the scanned home panel's `添加` button store imported directories locally:

```text
~/.codex-usage/imports.json
```

Imported directories are recognized as either:

- Codex homes containing `sessions/`, `archived_sessions/`, or `state_*.sqlite`
- Project log directories containing `.codex-usage/usage.jsonl`

For projects that call `codex-oauth` or OpenAI-compatible APIs directly, ask another AI agent to read [log-README.md](log-README.md) from this repository and instrument the target project. The target project should generate:

```text
<target-project>/.codex-usage/usage.jsonl
```

Then import `<target-project>` from the dashboard. Project logs should contain token counts, model, timestamp, project path, and session ID only. They should not contain prompts, responses, secrets, or OAuth tokens.

## Static Export

Generate a standalone HTML snapshot:

```bash
npm run export
```

Default output:

```text
dist/codex-usage.html
```

This file embeds the current usage data and frontend code. It is useful for temporary local viewing or private sharing, but it may contain local paths, project directories, session IDs, and usage details. For that reason, `dist/` is ignored by default and should not be committed to GitHub.

## JSON API

After starting the service, these endpoints are available:

```text
GET /api/status?since=<fingerprint>
GET /api/usage
GET /api/usage?force=1
GET /api/usage?detail=full
GET /api/pricing
GET /api/sessions
GET /api/sessions/<sessionId>/turns
GET /api/sessions/<sessionId>/turns/latest
GET /api/sessions/<sessionId>/turns/<turnId>/requests?offset=0&limit=100
GET /api/summary
GET /api/imports
POST /api/imports
DELETE /api/imports?path=<absolute-path>
```

Endpoint notes:

- `/api/status` checks whether new logs are available
- `/api/usage` returns lightweight `summary` and `metadata` by default
- `/api/usage?force=1` forces a full rescan
- `/api/usage?detail=full` returns the full `report` for debugging
- `/api/summary` returns only the summary wrapper
- `/api/sessions` lists selectable sessions; turn routes return lightweight summaries and request details are loaded on demand through the paginated route
- `/api/pricing` exposes the built-in pricing version for auditing
- `/api/imports` lists, adds, or removes directories imported from the dashboard

The default low-memory `gateway` may reject `detail=full` to avoid excessive memory usage. For full detail debugging, restart with a larger memory limit:

```bash
codex-usage restart --memory-mb 512
```

## Extra Codex Homes

If you have additional Codex home directories, pass them through `CODEX_USAGE_HOMES`. Multiple directories should be separated by the system path delimiter; on macOS/Linux, use `:`.

```bash
CODEX_USAGE_HOMES="/path/to/codex-home-1:/path/to/codex-home-2" npm run serve
```

An extra home should look like a Codex home and include at least one of:

```text
sessions/
archived_sessions/
state_5.sqlite
```

## Before Publishing to GitHub

Do not upload these files or directories:

- `.venv/`: local Python virtual environment
- `.idea/`, `.vscode/`: local IDE configuration
- `node_modules/`: dependency directory
- `dist/`: generated static snapshots that may contain personal usage data and local paths
- `.env`, `.env.*`: local environment variables and secrets
- `.codex/`, `sessions/`, `archived_sessions/`, `state_*.sqlite`: personal Codex data accidentally copied into the project

If you upload files through the GitHub web UI, check this manually as well. `.gitignore` only protects Git command-line commits.

## Development

Run tests:

```bash
npm test
```

The project currently has no third-party runtime dependencies. Main code lives in:

```text
src/
public/
test/
```

## License

This project is licensed under the [MIT License](LICENSE).
