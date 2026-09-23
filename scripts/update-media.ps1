param([Parameter(Mandatory=$true)][string]$RuntimeHome)
$ErrorActionPreference = 'Stop'
try {
    $health = Invoke-RestMethod -Uri 'https://clipforge.clanvelt.com/api/health/ready' -TimeoutSec 20
    $release = [string]$health.release
    if ($health.status -ne 'ready' -or $release -notmatch '^[a-f0-9]{40}$') { exit 0 }
    $currentFile = Join-Path $RuntimeHome 'current.json'
    if (Test-Path -LiteralPath $currentFile) {
        $current = Get-Content -Raw -LiteralPath $currentFile | ConvertFrom-Json
        if ($current.release -eq $release) { exit 0 }
    }
    gh release view "media-$release" --repo o-codify/clipforge --json tagName 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 0 }
    $releaseRoot = Join-Path $RuntimeHome "releases\$release"
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    gh release download "media-$release" --repo o-codify/clipforge --pattern 'clipforge-media.zip*' --dir $releaseRoot --clobber
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the prepared media runtime' }
    $archive = Join-Path $releaseRoot 'clipforge-media.zip'
    $expected = ((Get-Content -Raw -LiteralPath "$archive.sha256").Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Runtime checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $releaseRoot -Force
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $releaseRoot 'release.json') | ConvertFrom-Json
    if ($manifest.release -ne $release -or $manifest.entry -ne 'apps/worker/dist/main.mjs') { throw 'Unexpected runtime manifest' }
    & 'C:\Program Files\nodejs\node.exe' (Join-Path $releaseRoot $manifest.entry) --check-runtime
    if ($LASTEXITCODE -ne 0) { throw 'Prepared worker cannot start on this PC' }
    $temporaryPointer = Join-Path $RuntimeHome 'current.json.tmp'
    [IO.File]::WriteAllText($temporaryPointer, (@{release=$release;path=$releaseRoot;entry=$manifest.entry} | ConvertTo-Json))
    Move-Item -LiteralPath $temporaryPointer -Destination $currentFile -Force
    Write-Output "Prepared media release $release installed. No build was run on the PC."
} catch {
    # Keep the previous runtime and retry later; do not expose credentials in errors.
    Write-Output 'Media runtime update is unavailable; keeping the current release.'
    exit 1
}
