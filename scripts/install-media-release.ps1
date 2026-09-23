param([string]$Release = $env:GITHUB_SHA, [string]$RuntimeHome = $env:CLIPFORGE_MEDIA_HOME)
$ErrorActionPreference = 'Stop'
if (-not $RuntimeHome) { throw 'CLIPFORGE_MEDIA_HOME is required' }
if ($Release -notmatch '^[0-9a-f]{40}$') { throw 'A complete Git commit SHA is required' }
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $RuntimeHome "releases\$Release"
if (-not (Test-Path -LiteralPath $releaseRoot)) {
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    $archive = Join-Path $RuntimeHome "release-$Release.zip"
    git -C $sourceRoot archive --format=zip --output=$archive $Release
    if ($LASTEXITCODE -ne 0) { throw 'Could not export the tested release' }
    Expand-Archive -LiteralPath $archive -DestinationPath $releaseRoot
    Remove-Item -LiteralPath $archive
}
Push-Location $releaseRoot
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Worker dependencies failed' }
    pnpm exec turbo run build --filter=@clipforge/worker...
    if ($LASTEXITCODE -ne 0) { throw 'Worker build failed' }
} finally { Pop-Location }
$pointer = @{ release = $Release; path = $releaseRoot } | ConvertTo-Json
$temporaryPointer = Join-Path $RuntimeHome 'current.json.tmp'
[IO.File]::WriteAllText($temporaryPointer, $pointer)
Move-Item -LiteralPath $temporaryPointer -Destination (Join-Path $RuntimeHome 'current.json') -Force
Write-Output "Media release $Release is ready; the supervisor will switch automatically."
