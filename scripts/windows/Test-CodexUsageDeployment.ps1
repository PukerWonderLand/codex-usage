[CmdletBinding()]
param(
    [switch]$ScriptOnly,
    [switch]$TestRecovery,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stateDirectory = Join-Path $env:USERPROFILE '.codex-usage'
$manifestPath = Join-Path $stateDirectory 'windows-deployment.json'
$installerPath = Join-Path $PSScriptRoot 'Install-CodexUsage.ps1'
$uninstallerPath = Join-Path $PSScriptRoot 'Uninstall-CodexUsage.ps1'
$supervisorPath = Join-Path $PSScriptRoot 'run-dashboard.ps1'
$dispatcherPath = Join-Path $PSScriptRoot 'notify-dispatcher.mjs'

function Get-NodeRuntime {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\node.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    throw 'node.exe was not found.'
}

function Assert-PowerShellSyntax([string]$Path) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) {
        $messages = $errors | ForEach-Object { "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)" }
        throw "PowerShell syntax failed for $Path`: $($messages -join '; ')"
    }
}

if ($ScriptOnly) {
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | ForEach-Object { Assert-PowerShellSyntax $_.FullName }
    $launcher = [System.IO.File]::ReadAllText($supervisorPath)
    if ($launcher -match '[^\x00-\x7F]') { throw 'run-dashboard.ps1 must remain ASCII-only for Windows PowerShell 5.1.' }

    $nodePath = Get-NodeRuntime
    & $nodePath --check $dispatcherPath
    if ($LASTEXITCODE -ne 0) { throw 'notify-dispatcher.mjs failed node --check.' }

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-usage-windows-test-$PID-" + [guid]::NewGuid().ToString('N'))
    $originalUserProfile = $env:USERPROFILE
    $originalCodexHome = $env:CODEX_HOME
    try {
        $temporaryUser = Join-Path $temporaryRoot 'Unicode User 测试'
        $temporaryCodexHome = Join-Path $temporaryUser '.codex'
        $temporaryState = Join-Path $temporaryUser '.codex-usage'
        New-Item -ItemType Directory -Path $temporaryCodexHome, $temporaryState -Force | Out-Null
        $nestedManagedNotify = @(
            $nodePath,
            (Join-Path $temporaryState 'notify-dispatcher.mjs'),
            'C:\Tools\codex-usage\src\cli.js',
            'C:\Tools\existing-notify.exe',
            'turn-ended'
        )
        $wrappedNotify = @(
            'C:\Tools\codex-computer-use.exe',
            'turn-ended',
            '--previous-notify',
            (ConvertTo-Json -InputObject ([object[]]$nestedManagedNotify) -Compress)
        )
        [System.IO.File]::WriteAllText(
            (Join-Path $temporaryCodexHome 'config.toml'),
            ('notify = ' + (ConvertTo-Json -InputObject ([object[]]$wrappedNotify) -Compress)) + [Environment]::NewLine,
            (New-Object System.Text.UTF8Encoding($false))
        )
        $env:USERPROFILE = $temporaryUser
        $env:CODEX_HOME = $temporaryCodexHome

        $installOutput = @(& $installerPath -WhatIf -Json 6>&1) -join "`n"
        if ($installOutput -notmatch '"planned"\s*:\s*true') { throw "Installer -WhatIf did not report a planned installation. Output: $installOutput" }
        if ($installOutput -notmatch '"upstreamNotifyPreserved"\s*:\s*true') { throw "Installer -WhatIf did not preserve the existing notify command. Output: $installOutput" }
        if ($installOutput -notmatch '"upstreamNotifyArgumentCount"\s*:\s*2') { throw "Installer -WhatIf did not remove the nested managed dispatcher. Output: $installOutput" }
        if (Test-Path -LiteralPath (Join-Path $temporaryState 'windows-deployment.json')) { throw 'Installer -WhatIf wrote a deployment manifest.' }

        $syntheticManifest = [ordered]@{
            taskName = 'Codex Usage LAN Dashboard Test'
            firewallRuleName = $null
            notifyManaged = $true
            configPath = (Join-Path $temporaryCodexHome 'config.toml')
            port = 65534
            cliPath = (Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))) 'src\cli.js')
        }
        [System.IO.File]::WriteAllText(
            (Join-Path $temporaryState 'windows-deployment.json'),
            ($syntheticManifest | ConvertTo-Json),
            (New-Object System.Text.UTF8Encoding($false))
        )
        $uninstallOutput = @(& $uninstallerPath -WhatIf -Confirm:$false -Json 6>&1) -join "`n"
        if ($uninstallOutput -notmatch '"planned"\s*:\s*true') { throw 'Uninstaller -WhatIf did not report a planned uninstall.' }
        if (-not (Test-Path -LiteralPath (Join-Path $temporaryState 'windows-deployment.json'))) { throw 'Uninstaller -WhatIf removed the deployment manifest.' }
    }
    finally {
        $env:USERPROFILE = $originalUserProfile
        $env:CODEX_HOME = $originalCodexHome
        if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
    }

    $result = [ordered]@{
        mode = 'script-only'
        powershellSyntax = 'ok'
        dispatcherSyntax = 'ok'
        launcherAscii = $true
        installWhatIf = 'no writes'
        uninstallWhatIf = 'no writes'
    }
}
else {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Deployment manifest not found at $manifestPath"
    }
    $manifest = ([System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
    $task = Get-ScheduledTask -TaskName ([string]$manifest.taskName) -ErrorAction Stop
    $taskInfo = Get-ScheduledTaskInfo -TaskName ([string]$manifest.taskName)
    $listener = Get-NetTCPConnection -LocalPort ([int]$manifest.port) -State Listen -ErrorAction Stop | Select-Object -First 1
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
    if ($process.Name -ne 'node.exe' -or $process.CommandLine -notlike "*$([string]$manifest.cliPath)*") {
        throw "Port $($manifest.port) is not owned by the managed Codex Usage process."
    }

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($manifest.port)/api/usage?skipCheck=1" -TimeoutSec 10
    $stopwatch.Stop()
    if ($response.StatusCode -ne 200) { throw "Local HTTP status was $($response.StatusCode)." }
    $usage = $response.Content | ConvertFrom-Json
    if ([long]$usage.metadata.eventCount -le 0) { throw 'The dashboard returned zero indexed events.' }
    $databasePath = Join-Path $stateDirectory 'usage-index.sqlite'
    if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf) -or (Get-Item -LiteralPath $databasePath).Length -eq 0) {
        throw 'The SQLite usage index is missing or empty.'
    }

    $firewallStatus = 'not managed'
    if ($manifest.firewallRuleName) {
        $rule = Get-NetFirewallRule -DisplayName ([string]$manifest.firewallRuleName) -ErrorAction Stop
        $portFilter = $rule | Get-NetFirewallPortFilter
        $addressFilter = $rule | Get-NetFirewallAddressFilter
        if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or $rule.Profile -notmatch 'Private') {
            throw 'The managed firewall rule is not an enabled Private inbound allow rule.'
        }
        if ([int]$portFilter.LocalPort -ne [int]$manifest.port) { throw 'The managed firewall port does not match the manifest.' }
        if ([string]$manifest.firewallScope -eq 'LocalSubnet' -and $addressFilter.RemoteAddress -notcontains 'LocalSubnet') {
            throw 'The managed firewall rule is not limited to LocalSubnet.'
        }
        $firewallStatus = 'ok'
    }

    $oldPid = [int]$listener.OwningProcess
    $newPid = $oldPid
    $recoverySeconds = $null
    if ($TestRecovery) {
        $recoveryWatch = [Diagnostics.Stopwatch]::StartNew()
        Stop-Process -Id $oldPid -Force
        $deadline = (Get-Date).AddSeconds(20)
        $replacement = $null
        do {
            Start-Sleep -Milliseconds 200
            $replacement = Get-NetTCPConnection -LocalPort ([int]$manifest.port) -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.OwningProcess -ne $oldPid } |
                Select-Object -First 1
        } until ($replacement -or (Get-Date) -ge $deadline)
        $recoveryWatch.Stop()
        if (-not $replacement) { throw 'The supervisor did not restore the dashboard within 20 seconds.' }
        $newPid = [int]$replacement.OwningProcess
        $recoverySeconds = [math]::Round($recoveryWatch.Elapsed.TotalSeconds, 3)
        $recovered = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($manifest.port)/" -TimeoutSec 10
        if ($recovered.StatusCode -ne 200) { throw 'The recovered dashboard did not return HTTP 200.' }
    }

    $result = [ordered]@{
        mode = 'deployment'
        taskState = [string]$task.State
        taskResult = [int]$taskInfo.LastTaskResult
        listenAddress = [string]$listener.LocalAddress
        port = [int]$manifest.port
        processId = $newPid
        httpStatus = [int]$response.StatusCode
        httpSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 6)
        eventCount = [long]$usage.metadata.eventCount
        sqliteBytes = (Get-Item -LiteralPath $databasePath).Length
        firewall = $firewallStatus
        recoveryTested = [bool]$TestRecovery
        previousProcessId = $oldPid
        recoverySeconds = $recoverySeconds
    }
}

if ($Json) { $result | ConvertTo-Json -Depth 4 }
else { [pscustomobject]$result | Format-List }
