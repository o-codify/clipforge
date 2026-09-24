param([Parameter(Mandatory=$true)][string]$RuntimeHome, [switch]$CheckOnly)
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
    $releaseInfo = gh api "repos/o-codify/clipforge/releases/tags/media-$release" 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { exit 0 }
    if ($CheckOnly) { exit 10 }
    $releaseRoot = Join-Path $RuntimeHome "releases\$release"
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    $networkKbps = 10000
    foreach ($line in Get-Content -LiteralPath (Join-Path $RuntimeHome '.env')) {
        if ($line -match '^MEDIA_NETWORK_KBPS=(\d+)$') { $networkKbps = [int]$Matches[1] }
    }
    if ($networkKbps -lt 100 -or $networkKbps -gt 40000) { throw 'Invalid media bandwidth limit' }
    $githubToken = gh auth token
    if ($LASTEXITCODE -ne 0) { throw 'GitHub authentication unavailable' }
    foreach ($name in @('clipforge-media.zip', 'clipforge-media.zip.sha256')) {
        $asset = @($releaseInfo.assets | Where-Object name -eq $name)
        if ($asset.Count -ne 1 -or $asset[0].url -notmatch '^https://api.github.com/repos/o-codify/clipforge/releases/assets/\d+$') { throw 'Invalid prepared release asset' }
        # Keep the token off the command line and do not forward it to redirect hosts.
        $curlConfig = 'url = "' + $asset[0].url + '"' + "`n" +
            'header = "Accept: application/octet-stream"' + "`n" +
            'header = "Authorization: Bearer ' + $githubToken.Trim() + '"'
        $curlConfig | curl.exe --config - --location --fail --silent --show-error --max-time 160 --limit-rate ([int]($networkKbps * 1000 / 8)) --output (Join-Path $releaseRoot $name)
        if ($LASTEXITCODE -ne 0) { throw 'Could not download the prepared media runtime' }
    }
    $githubToken = $null
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
