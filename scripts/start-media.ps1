param([string]$RuntimeHome = 'C:\Users\User\ClipForgeWorker')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $RuntimeHome
while ($true) {
    try {
        $release = Get-Content -Raw -LiteralPath (Join-Path $RuntimeHome 'current.json') | ConvertFrom-Json
        $supervisor = Join-Path $release.path 'supervisor.mjs'
        if (-not (Test-Path -LiteralPath $supervisor)) { $supervisor = Join-Path $RuntimeHome 'supervisor.mjs' }
        $settings = @{}
        foreach ($line in Get-Content -LiteralPath (Join-Path $RuntimeHome '.env')) {
            if ($line -match '^(PYTHON_BIN|MEDIA_MEMORY_MB|MEDIA_CPU_PERCENT|MEDIA_MIN_FREE_MB)=(.*)$') {
                $settings[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
            }
        }
        $memory = if ($settings.MEDIA_MEMORY_MB) { [int]$settings.MEDIA_MEMORY_MB } else { 4096 }
        $cpu = if ($settings.MEDIA_CPU_PERCENT) { [int]$settings.MEDIA_CPU_PERCENT } else { 20 }
        $headroom = if ($settings.MEDIA_MIN_FREE_MB) { [int]$settings.MEDIA_MIN_FREE_MB } else { 8192 }
        $limiter = Join-Path $release.path 'run-media-limited.py'
        if (-not (Test-Path -LiteralPath $limiter)) { throw 'Prepared runtime lacks memory limits' }
        & $settings.PYTHON_BIN $limiter --memory-mb $memory --cpu-percent $cpu --min-free-mb $headroom -- 'C:\Program Files\nodejs\node.exe' $supervisor $RuntimeHome
    } catch {
        # The persistent task remains alive during a temporary update or startup failure.
    }
    Start-Sleep -Seconds 10
}
