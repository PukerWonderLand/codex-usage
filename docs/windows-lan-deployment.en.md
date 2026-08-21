# Windows LAN Deployment

This guide deploys Codex Usage as a LAN service for the current Windows user. The installer creates a scheduled task, a restart supervisor, a Codex notification dispatcher, and a Private/LocalSubnet inbound firewall rule.

## Scope and security boundary

- Windows 10 or Windows 11.
- Node.js `>=22.13`; the installer can also discover the Node.js runtime bundled with the Codex desktop app.
- Codex user data defaults to `%USERPROFILE%\.codex`; `CODEX_HOME` is honored when set.
- The task starts after the current user signs in. It does not run before logon.
- The dashboard uses unencrypted HTTP and exposes usage, session titles, and project paths. Keep it on a trusted Private LAN. Do not expose it through router port forwarding or a public firewall.

The scripts never read `auth.json`, and the dispatcher never writes the Codex Hook JSON payload to logs.

## 1. Clone and preflight

```powershell
git clone https://github.com/PukerWonderLand/codex-usage.git
Set-Location .\codex-usage
node --version
```

Run a read-only preview from a normal PowerShell window:

```powershell
.\scripts\windows\Install-CodexUsage.ps1 -WhatIf -Json
```

`-WhatIf` creates no files, tasks, or firewall rules. Check the project directory, Node path, port, and LAN URLs in its output.

## 2. Install

Open Windows PowerShell as Administrator and run:

```powershell
Set-Location C:\path\to\codex-usage
.\scripts\windows\Install-CodexUsage.ps1
```

Common options:

```powershell
# Use another port
.\scripts\windows\Install-CodexUsage.ps1 -Port 4000

# Localhost only, with no firewall change
.\scripts\windows\Install-CodexUsage.ps1 -BindAddress 127.0.0.1 -NoFirewall

# Leave Codex notify unchanged
.\scripts\windows\Install-CodexUsage.ps1 -SkipNotify

# Allow more time for the first index build on a very large history
.\scripts\windows\Install-CodexUsage.ps1 -HealthTimeoutSeconds 600
```

Default resources:

| Resource | Default |
| --- | --- |
| Scheduled task | `Codex Usage LAN Dashboard` |
| Listener | `0.0.0.0:3765` |
| Firewall | Private, TCP 3765, LocalSubnet |
| State directory | `%USERPROFILE%\.codex-usage` |
| SQLite index | `%USERPROFILE%\.codex-usage\usage-index.sqlite` |
| Trigger | Current-user AtLogOn |

The installer backs up `%USERPROFILE%\.codex\config.toml`. If a `notify` command already exists, the new dispatcher invokes both the Codex Usage Hook and the upstream command instead of replacing it. Codex defines `notify` as a user-level string array that receives a JSON payload; see the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## 3. Local acceptance

```powershell
.\scripts\windows\Test-CodexUsageDeployment.ps1 -Json
```

The verifier checks that:

- The scheduled task exists and is running.
- The expected Node/Codex Usage process owns the listener.
- `/api/usage` returns HTTP 200.
- The SQLite index exists and is non-empty.
- The firewall is a Private inbound allow rule with the expected port and LocalSubnet scope.

While a long-running task is active, `LastTaskResult` may be decimal `267009` (`0x41301`). This means the task is still running; it is not a failure.

To terminate one managed dashboard child and prove supervisor recovery:

```powershell
.\scripts\windows\Test-CodexUsageDeployment.ps1 -TestRecovery -Json
```

The switch stops only a Node process whose command line and deployment manifest both identify it as this Codex Usage instance.

## 4. Real LAN acceptance

Confirm that the Windows connection uses the Private category:

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory
```

List usable IPv4 addresses:

```powershell
Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred |
    Where-Object IPAddress -notmatch '^(127\.|169\.254\.)' |
    Select-Object InterfaceAlias,IPAddress
```

From another computer on the LAN—not from the server accessing its own LAN IP—run:

```bash
curl -o /dev/null -sS -w "HTTP=%{http_code} seconds=%{time_total}\n" http://SERVER_LAN_IP:3765/
```

Acceptance requires remote HTTP 200 and successful loading of the home page, session switching, turn lists, and turn request details.

## 5. Codex Hook acceptance

Complete a real Codex turn, then inspect only the snapshot metadata:

```powershell
Get-Item "$env:USERPROFILE\.codex-usage\latest-turn.json" |
    Select-Object LastWriteTime,Length
```

Do not print the full Hook payload. If the Hook or upstream notifier fails, inspect the payload-free error summary:

```powershell
Get-Content "$env:USERPROFILE\.codex-usage\notify-errors.log" -Tail 20
```

## 6. Upgrade

After pulling a new release, rerun the installer from an administrator PowerShell:

```powershell
git pull --ff-only
.\scripts\windows\Install-CodexUsage.ps1
```

Installation is idempotent. It refreshes the manifest, supervisor, dispatcher, scheduled task, and managed firewall rule. It also extracts the original upstream command from an existing managed notify chain so dispatchers never become nested.

## 7. Troubleshooting

```powershell
Get-ScheduledTask -TaskName 'Codex Usage LAN Dashboard'
Get-ScheduledTaskInfo -TaskName 'Codex Usage LAN Dashboard'
Get-NetTCPConnection -LocalPort 3765 -State Listen
Get-Content "$env:USERPROFILE\.codex-usage\dashboard-supervisor.log" -Tail 30
Get-Content "$env:USERPROFILE\.codex-usage\dashboard-stderr.log" -Tail 30
```

Common failures:

- `node.exe was not found`: install Node.js 22.13+, or repair the Codex desktop installation.
- Port already in use: choose another `-Port`; use `-Force` only after confirming the target.
- Local HTTP works but remote HTTP fails: verify the Private network category, switch/VLAN reachability, and the LocalSubnet firewall scope.
- Unicode path startup failure: the supervisor intentionally remains ASCII and reads real paths from a UTF-8 manifest. Do not hard-code machine-specific Unicode paths into the launcher.

## 8. Uninstall and rollback

From an administrator PowerShell:

```powershell
.\scripts\windows\Uninstall-CodexUsage.ps1 -WhatIf
.\scripts\windows\Uninstall-CodexUsage.ps1
```

The default uninstall:

- Stops and unregisters the managed task.
- Removes its managed firewall rule.
- Restores the upstream `notify` command.
- Removes deployment scripts and runtime logs.
- Preserves SQLite, turn cache, and snapshot data.

Remove all local index data only when explicitly intended:

```powershell
.\scripts\windows\Uninstall-CodexUsage.ps1 -RemoveData
```

`-RemoveData` recursively deletes `%USERPROFILE%\.codex-usage` and cannot be undone.
