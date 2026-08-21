$ErrorActionPreference = 'Stop'
$stateDirectory = Join-Path $env:USERPROFILE '.codex-usage'
$manifestPath = Join-Path $stateDirectory 'windows-deployment.json'
$supervisorLog = Join-Path $stateDirectory 'dashboard-supervisor.log'
$stdoutLog = Join-Path $stateDirectory 'dashboard-stdout.log'
$stderrLog = Join-Path $stateDirectory 'dashboard-stderr.log'

while ($true) {
    try {
        $json = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
        $manifest = $json | ConvertFrom-Json
        $defaultCodexHome = Join-Path ([string]$manifest.userHome) '.codex'
        if ([string]$manifest.codexHome -ne $defaultCodexHome) {
            $env:CODEX_USAGE_HOMES = [string]$manifest.codexHome
        }
        $arguments = @(
            '--no-warnings',
            '--max-old-space-size=512',
            [string]$manifest.cliPath,
            'run',
            '--host',
            [string]$manifest.bindAddress,
            '--port',
            [string]$manifest.port,
            '--home-dir',
            [string]$manifest.userHome
        )

        Add-Content -LiteralPath $supervisorLog -Encoding UTF8 -Value "$(Get-Date -Format o) starting dashboard"
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & ([string]$manifest.nodePath) @arguments 1>> $stdoutLog 2>> $stderrLog
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        Add-Content -LiteralPath $supervisorLog -Encoding UTF8 -Value "$(Get-Date -Format o) dashboard exited code=$exitCode; restarting in 2 seconds"
    }
    catch {
        $safeMessage = $_.Exception.Message -replace '[\r\n]+', ' '
        Add-Content -LiteralPath $supervisorLog -Encoding UTF8 -Value "$(Get-Date -Format o) supervisor error=$safeMessage; retrying in 2 seconds"
    }
    Start-Sleep -Seconds 2
}
