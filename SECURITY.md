# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories instead of opening a public issue. Include affected versions, reproduction steps, and the expected impact.

## Data handling

Codex Usage reads local Codex session metadata. Reports may contain project paths, session identifiers, model names, and token counts. It must not collect prompt or response text, API keys, OAuth tokens, or other credentials. Do not publish generated dashboards, SQLite indexes, imported logs, or real session fixtures.

The dashboard binds to `127.0.0.1` by default. Binding to `0.0.0.0` exposes metadata to the local network and should only be done on a trusted network or behind an authenticated reverse proxy.
