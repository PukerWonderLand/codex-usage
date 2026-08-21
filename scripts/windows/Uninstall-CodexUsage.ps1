[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$RemoveData,
    [switch]$KeepNotify,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stateDirectory = Join-Path $env:USERPROFILE '.codex-usage'
$manifestPath = Join-Path $stateDirectory 'windows-deployment.json'
$installedSupervisor = Join-Path $stateDirectory 'run-dashboard.ps1'
$installedDispatcher = Join-Path $stateDirectory 'notify-dispatcher.mjs'
$isWhatIf = [bool]$WhatIfPreference

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Utf8File([string]$Path, [string]$Content) {
    $tempPath = "$Path.codex-usage.tmp"
    [System.IO.File]::WriteAllText($tempPath, $Content, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Get-NotifySetting([string]$Content) {
    $regex = [regex]'(?m)^[\t ]*notify[\t ]*=[\t ]*(\[[^\r\n]*\])[\t ]*(?:#.*)?\r?$'
    $match = $regex.Match($Content)
    if (-not $match.Success) { return [pscustomobject]@{ Found = $false; Match = $null; Values = @() } }
    try {
        $parsed = $match.Groups[1].Value | ConvertFrom-Json
        $values = if ($parsed -is [System.Array]) { [object[]]$parsed } else { @($parsed) }
    }
    catch { throw 'The current top-level notify setting is not a supported one-line string array.' }
    return [pscustomobject]@{ Found = $true; Match = $match; Values = [string[]]$values }
}

function Restore-UpstreamNotify([string]$Content, [string]$ManagedDispatcher) {
    $setting = Get-NotifySetting $Content
    if (-not $setting.Found -or $setting.Values.Count -lt 4) { return $Content }
    if ([System.IO.Path]::GetFullPath([string]$setting.Values[1]) -ne [System.IO.Path]::GetFullPath($ManagedDispatcher)) { return $Content }

    $count = 0
    if (-not [int]::TryParse([string]$setting.Values[3], [ref]$count) -or $count -lt 0 -or $setting.Values.Count -ne (4 + $count)) {
        throw 'The managed notify setting has an unexpected shape. It was left unchanged for safety.'
    }
    if ($count -gt 0) {
        $upstream = [string[]]$setting.Values[4..($setting.Values.Count - 1)]
        $jsonArray = ConvertTo-Json -InputObject ([object[]]$upstream) -Compress
        return $Content.Remove($setting.Match.Index, $setting.Match.Length).Insert($setting.Match.Index, "notify = $jsonArray")
    }

    $start = $setting.Match.Index
    $length = $setting.Match.Length
    if ($start + $length -lt $Content.Length -and $Content.Substring($start + $length).StartsWith("`r`n")) { $length += 2 }
    elseif ($start + $length -lt $Content.Length -and $Content[$start + $length] -eq "`n") { $length += 1 }
    return $Content.Remove($start, $length)
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "No Windows deployment manifest was found at $manifestPath"
}
$manifest = ([System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)

if (-not $isWhatIf -and -not (Test-IsAdministrator)) {
    throw 'Run this uninstaller from an administrator PowerShell window. -WhatIf can be used without elevation.'
}

if ($isWhatIf) {
    $null = $PSCmdlet.ShouldProcess([string]$manifest.taskName, 'Stop and unregister the scheduled task')
    if ($manifest.firewallRuleName) { $null = $PSCmdlet.ShouldProcess([string]$manifest.firewallRuleName, 'Remove the managed firewall rule') }
    if (-not $KeepNotify -and $manifest.notifyManaged) { $null = $PSCmdlet.ShouldProcess([string]$manifest.configPath, 'Restore the upstream Codex notify command') }
    $null = $PSCmdlet.ShouldProcess($stateDirectory, $(if ($RemoveData) { 'Remove deployment files and all indexed data' } else { 'Remove deployment files and preserve indexed data' }))
}
else {
    $task = Get-ScheduledTask -TaskName ([string]$manifest.taskName) -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName ([string]$manifest.taskName) -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Unregister-ScheduledTask -TaskName ([string]$manifest.taskName) -Confirm:$false
    }

    $listeners = @(Get-NetTCPConnection -LocalPort ([int]$manifest.port) -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -like "*$([string]$manifest.cliPath)*") {
            Stop-Process -Id $listener.OwningProcess -Force
        }
    }

    if ($manifest.firewallRuleName) {
        Get-NetFirewallRule -DisplayName ([string]$manifest.firewallRuleName) -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    }

    if (-not $KeepNotify -and $manifest.notifyManaged -and (Test-Path -LiteralPath ([string]$manifest.configPath) -PathType Leaf)) {
        $content = [System.IO.File]::ReadAllText([string]$manifest.configPath, [System.Text.Encoding]::UTF8)
        $restored = Restore-UpstreamNotify -Content $content -ManagedDispatcher $installedDispatcher
        if ($restored -ne $content) { Write-Utf8File -Path ([string]$manifest.configPath) -Content $restored }
    }

    if ($RemoveData) {
        $resolvedState = [System.IO.Path]::GetFullPath($stateDirectory)
        $expectedState = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex-usage'))
        if ($resolvedState -ne $expectedState -or $resolvedState.Length -lt 10) { throw 'Refusing to remove an unexpected state directory.' }
        Remove-Item -LiteralPath $resolvedState -Recurse -Force
    }
    else {
        @(
            $installedSupervisor,
            $installedDispatcher,
            $manifestPath,
            (Join-Path $stateDirectory 'dashboard-supervisor.log'),
            (Join-Path $stateDirectory 'dashboard-stdout.log'),
            (Join-Path $stateDirectory 'dashboard-stderr.log')
        ) | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    }
}

$result = [ordered]@{
    planned = $isWhatIf
    taskName = [string]$manifest.taskName
    firewallRuleName = [string]$manifest.firewallRuleName
    notifyRestored = -not [bool]$KeepNotify -and [bool]$manifest.notifyManaged
    dataRemoved = [bool]$RemoveData
    stateDirectory = $stateDirectory
}
if ($Json) { $result | ConvertTo-Json -Depth 3 }
else { [pscustomobject]$result | Format-List }
