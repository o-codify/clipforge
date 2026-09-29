param([string]$RuntimeHome = 'C:\Users\User\ClipForgeWorker', [string]$Workspace = '')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $RuntimeHome
$launcherLog = Join-Path $RuntimeHome 'logs/launcher.log'
New-Item -ItemType Directory -Path (Split-Path -Parent $launcherLog) -Force | Out-Null
while ($true) {
    try {
        $release = Get-Content -Raw -LiteralPath (Join-Path $RuntimeHome 'current.json') | ConvertFrom-Json
        $supervisor = Join-Path $release.path 'supervisor.mjs'
        if (-not (Test-Path -LiteralPath $supervisor)) { $supervisor = Join-Path $RuntimeHome 'supervisor.mjs' }
        if ($Workspace) { $supervisor = Join-Path $Workspace 'scripts/media-pc.mjs' }
        $settings = @{}
        foreach ($line in Get-Content -LiteralPath (Join-Path $RuntimeHome '.env')) {
            if ($line -match '^(PYTHON_BIN|MEDIA_[A-Z_]+)=(.*)$') {
                $settings[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
                if ($Matches[1] -like 'MEDIA_*') { [Environment]::SetEnvironmentVariable($Matches[1], $settings[$Matches[1]], 'Process') }
            }
        }
        $memory = if ($settings.MEDIA_MEMORY_MB) { [int]$settings.MEDIA_MEMORY_MB } else { 0 }
        $cpu = if ($settings.MEDIA_CPU_TARGET) { [int]$settings.MEDIA_CPU_TARGET } else { 90 }
        $idle = if ($settings.MEDIA_IDLE_SECONDS) { [int]$settings.MEDIA_IDLE_SECONDS } else { 0 }
        $limiter = Join-Path $release.path 'run-media-limited.py'
        if ($Workspace) { $limiter = Join-Path $Workspace 'scripts/run-media-limited.py' }
        if (-not (Test-Path -LiteralPath $limiter)) { throw 'Prepared runtime lacks memory limits' }
        $workspaceArgs = if ($Workspace) { @('--workspace', $Workspace) } else { @() }
        # Windows PowerShell turns each stderr line into an ErrorRecord.
        # Drain the complete traceback instead of interrupting it on line one.
        try {
            $ErrorActionPreference = 'Continue'
            & $settings.PYTHON_BIN $limiter --memory-mb $memory --cpu-percent $cpu --idle-seconds $idle --state-file (Join-Path $RuntimeHome 'resources.json') -- 'C:\Program Files\nodejs\node.exe' $supervisor $RuntimeHome @workspaceArgs >> $launcherLog 2>&1
        } finally { $ErrorActionPreference = 'Stop' }
    } catch {
        # The persistent task remains alive during a temporary update or startup failure.
        Add-Content -LiteralPath $launcherLog -Value "$(Get-Date -Format o) Launcher: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 10
}
