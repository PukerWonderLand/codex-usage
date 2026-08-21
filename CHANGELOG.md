# Changelog

All notable changes to this project will be documented in this file. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-08-21

### Added

- Per-session selection and URL binding with `sessionId`.
- Native per-turn token, cache, API-equivalent cost, and context-window analysis.
- Per-turn dashboard table and session insight cards.
- `codex-usage turn` and Codex notify-hook snapshot support.
- Versioned GPT-5.6 Sol pricing rules and long-context multipliers.
- Idempotent Windows LAN installer, scheduled-task supervisor, firewall setup, rollback, and deployment verifier.
- Windows CI coverage on Node.js 22 and 24.

### Changed

- Growing Codex JSONL files now resume from a persisted byte offset and parser state instead of reparsing their historical contents.
- SQLite hourly rollups keep dashboard refreshes responsive for multi-gigabyte histories.
- Codex notify integration preserves and chains an existing notification command.

### Security

- Windows firewall rules default to the Private profile and `LocalSubnet` only.
- Hook failures are logged without storing notification payloads, and deployment scripts never read `auth.json`.
