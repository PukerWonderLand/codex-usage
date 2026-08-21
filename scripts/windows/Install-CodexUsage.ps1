[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3765,

    [ValidateNotNullOrEmpty()]
    [string]$BindAddress = '0.0.0.0',

    [ValidateSet('LocalSubnet', 'Any')]
    [string]$FirewallScope = 'LocalSubnet',

    [ValidateRange(10, 900)]
    [int]$HealthTimeoutSeconds = 180,

    [switch]$NoFirewall,
    [switch]$SkipNotify,
    [switch]$Force,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Codex Usage LAN Dashboard'
$firewallRuleName = "Codex Usage LAN Dashboard (TCP $Port)"
$stateDirectory = Join-Path $env:USERPROFILE '.codex-usage'
$manifestPath = Join-Path $stateDirectory 'windows-deployment.json'
$installedSupervisor = Join-Path $stateDirectory 'run-dashboard.ps1'
$installedDispatcher = Join-Path $stateDirectory 'notify-dispatcher.mjs'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$cliPath = Join-Path $projectRoot 'src\cli.js'
$userHome = [System.IO.Path]::GetFullPath($env:USERPROFILE)
$codexHome = if ($env:CODEX_HOME) { [System.IO.Path]::GetFullPath($env:CODEX_HOME) } else { Join-Path $env:USERPROFILE '.codex' }
$configPath = Join-Path $codexHome 'config.toml'
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

function Get-NodeRuntime {
    $candidates = @()
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $versionText = & $candidate -p 'process.versions.node' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $versionText) { continue }
        $version = [version]($versionText.Trim().Split('-')[0])
        if ($version -ge [version]'22.13.0') {
            return [pscustomobject]@{ Path = [System.IO.Path]::GetFullPath($candidate); Version = $version.ToString() }
        }
    }
    throw 'Node.js >= 22.13 was not found. Install Node.js or the Codex desktop app before continuing.'
}

function Get-NotifySetting([string]$Content) {
    $regex = [regex]'(?m)^[\t ]*notify[\t ]*=[\t ]*(\[[^\r\n]*\])[\t ]*(?:#.*)?\r?$'
    $match = $regex.Match($Content)
    if (-not $match.Success) {
        return [pscustomobject]@{ Found = $false; Match = $null; Values = @() }
    }
    try {
        $parsed = $match.Groups[1].Value | ConvertFrom-Json
        $values = if ($parsed -is [System.Array]) { [object[]]$parsed } else { @($parsed) }
    }
    catch {
        throw 'The existing top-level notify setting is not a supported one-line string array. Use -SkipNotify or simplify it before installing.'
    }
    if (@($values | Where-Object { $_ -isnot [string] }).Count -gt 0) {
        throw 'The existing notify setting must contain only strings.'
    }
    return [pscustomobject]@{ Found = $true; Match = $match; Values = [string[]]$values }
}

function Set-NotifySetting([string]$Content, [string[]]$Values) {
    $setting = Get-NotifySetting $Content
    $jsonArray = ConvertTo-Json -InputObject ([object[]]$Values) -Compress
    $line = "notify = $jsonArray"
    if ($setting.Found) {
        return $Content.Remove($setting.Match.Index, $setting.Match.Length).Insert($setting.Match.Index, $line)
    }
    if ($Content.Length -and -not $Content.EndsWith("`n")) { $Content += "`r`n" }
    return $Content + $line + "`r`n"
}

function Get-UpstreamNotify([string[]]$Current, [string]$ManagedDispatcher) {
    if ($Current.Count -lt 2) { return $Current }
    $currentDispatcher = [System.IO.Path]::GetFullPath([string]$Current[1])
    if ($currentDispatcher -ne [System.IO.Path]::GetFullPath($ManagedDispatcher)) { return $Current }

    if ($Current.Count -ge 4) {
        $count = 0
        if ([int]::TryParse([string]$Current[3], [ref]$count) -and $count -ge 0 -and $Current.Count -eq (4 + $count)) {
            if ($count -eq 0) { return @() }
            return [string[]]$Current[4..($Current.Count - 1)]
        }
    }

    # Migrate the legacy dispatcher shape used by early Windows deployments:
    # node, dispatcher, usage-cli, upstream-command, upstream-args...
    if ($Current.Count -gt 3) { return [string[]]$Current[3..($Current.Count - 1)] }
    return @()
}

function Remove-NestedManagedNotify([string[]]$Upstream, [string]$ManagedDispatcher) {
    for ($index = 0; $index -lt ($Upstream.Count - 1); $index += 1) {
        if ($Upstream[$index] -ne '--previous-notify') { continue }
        try {
            $parsed = $Upstream[$index + 1] | ConvertFrom-Json
            $nested = if ($parsed -is [System.Array]) { [object[]]$parsed } else { @($parsed) }
            $isManaged = $nested.Count -ge 2 -and
                [System.IO.Path]::GetFullPath([string]$nested[1]) -eq [System.IO.Path]::GetFullPath($ManagedDispatcher)
        }
        catch {
            $isManaged = $false
        }
        if (-not $isManaged) { continue }

        $before = if ($index -gt 0) { [string[]]$Upstream[0..($index - 1)] } else { @() }
        $after = if (($index + 2) -lt $Upstream.Count) { [string[]]$Upstream[($index + 2)..($Upstream.Count - 1)] } else { @() }
        return @($before) + @($after)
    }
    return $Upstream
}

function Stop-ManagedListener([int]$LocalPort, [string]$ExpectedCli, [bool]$AllowForce) {
    $listeners = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        $isManaged = $process -and $process.Name -eq 'node.exe' -and $process.CommandLine -like "*$ExpectedCli*"
        if (-not $isManaged -and -not $AllowForce) {
            throw "TCP port $LocalPort is owned by an unmanaged process (PID $($listener.OwningProcess)). Choose another port or use -Force."
        }
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
    }
}

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Codex Usage CLI was not found at $cliPath"
}
$node = Get-NodeRuntime

if (-not $isWhatIf -and -not (Test-IsAdministrator)) {
    throw 'Run this installer from an administrator PowerShell window. -WhatIf can be used without elevation.'
}

$configContent = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
} else { '' }
$upstreamNotify = @()
$managedNotify = @()
$configBackup = $null

if (-not $SkipNotify) {
    $notifySetting = Get-NotifySetting $configContent
    $upstreamNotify = @(Get-UpstreamNotify -Current $notifySetting.Values -ManagedDispatcher $installedDispatcher)
    $upstreamNotify = @(Remove-NestedManagedNotify -Upstream $upstreamNotify -ManagedDispatcher $installedDispatcher)
    $managedNotify = @(
        $node.Path,
        $installedDispatcher,
        $cliPath,
        [string]@($upstreamNotify).Count
    ) + $upstreamNotify
}

if ($isWhatIf) {
    $null = $PSCmdlet.ShouldProcess($stateDirectory, 'Create deployment state and copy Windows runtime files')
    if (-not $SkipNotify) { $null = $PSCmdlet.ShouldProcess($configPath, 'Back up and install the managed Codex notify dispatcher') }
    $null = $PSCmdlet.ShouldProcess($taskName, 'Register and start the current-user scheduled task')
    if (-not $NoFirewall) { $null = $PSCmdlet.ShouldProcess($firewallRuleName, "Allow private TCP $Port from $FirewallScope") }
}
else {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $codexHome -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-dashboard.ps1') -Destination $installedSupervisor -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'notify-dispatcher.mjs') -Destination $installedDispatcher -Force

    if (-not $SkipNotify) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $configBackup = "$configPath.codex-usage-backup-$stamp"
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            Copy-Item -LiteralPath $configPath -Destination $configBackup -Force
        }
        else {
            Write-Utf8File -Path $configBackup -Content ''
        }
        $updatedConfig = Set-NotifySetting -Content $configContent -Values $managedNotify
        Write-Utf8File -Path $configPath -Content $updatedConfig
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        projectRoot = $projectRoot
        cliPath = $cliPath
        nodePath = $node.Path
        nodeVersion = $node.Version
        userHome = $userHome
        codexHome = $codexHome
        bindAddress = $BindAddress
        port = $Port
        taskName = $taskName
        firewallRuleName = $firewallRuleName
        firewallScope = if ($NoFirewall) { $null } else { $FirewallScope }
        notifyManaged = -not [bool]$SkipNotify
        configPath = $configPath
        configBackup = $configBackup
    }
    Write-Utf8File -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 4)

    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Stop-ManagedListener -LocalPort $Port -ExpectedCli $cliPath -AllowForce ([bool]$Force)

    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$installedSupervisor`""
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Runs the Codex Usage LAN dashboard with a restart supervisor.' -Force | Out-Null

    if (-not $NoFirewall) {
        Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress $FirewallScope | Out-Null
    }

    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    $response = $null
    do {
        Start-Sleep -Milliseconds 500
        try { $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2 } catch { $response = $null }
    } until ($response -or (Get-Date) -ge $deadline)
    if (-not $response -or $response.StatusCode -ne 200) {
        throw "The scheduled task was registered, but http://127.0.0.1:$Port/ did not return HTTP 200 within $HealthTimeoutSeconds seconds."
    }
}

$lanAddresses = @(
    Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Select-Object -ExpandProperty IPAddress -Unique |
        ForEach-Object { "http://$($_):$Port/" }
)
$result = [ordered]@{
    planned = $isWhatIf
    taskName = $taskName
    firewallRuleName = if ($NoFirewall) { $null } else { $firewallRuleName }
    nodePath = $node.Path
    nodeVersion = $node.Version
    projectRoot = $projectRoot
    stateDirectory = $stateDirectory
    configPath = $configPath
    notifyManaged = -not [bool]$SkipNotify
    upstreamNotifyPreserved = @($upstreamNotify).Count -gt 0
    upstreamNotifyArgumentCount = @($upstreamNotify).Count
    localUrl = "http://127.0.0.1:$Port/"
    lanUrls = $lanAddresses
}

if ($Json) { $result | ConvertTo-Json -Depth 4 }
else { [pscustomobject]$result | Format-List }
