param([string]$RuntimeHome = 'C:\Users\User\ClipForgeWorker')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $RuntimeHome
while ($true) {
    try {
        $release = Get-Content -Raw -LiteralPath (Join-Path $RuntimeHome 'current.json') | ConvertFrom-Json
        $supervisor = Join-Path $release.path 'supervisor.mjs'
        if (-not (Test-Path -LiteralPath $supervisor)) { $supervisor = Join-Path $RuntimeHome 'supervisor.mjs' }
        & 'C:\Program Files\nodejs\node.exe' $supervisor $RuntimeHome
    } catch {
        # The persistent task remains alive during a temporary update or startup failure.
    }
    Start-Sleep -Seconds 10
}
