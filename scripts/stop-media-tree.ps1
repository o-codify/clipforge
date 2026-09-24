param([int]$ParentProcess, [long]$StartedMilliseconds)
$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::FromUnixTimeMilliseconds($StartedMilliseconds).UtcDateTime
$processes = @(Get-CimInstance Win32_Process)
$root = $processes | Where-Object ProcessId -eq $ParentProcess
# Do not act on a reused PID belonging to another process.
if ($root -and ([Math]::Abs(($root.CreationDate.ToUniversalTime() - $started).TotalSeconds) -gt 5)) { exit 0 }
$ids = [Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($ParentProcess)
do {
    $before = $ids.Count
    foreach ($entry in $processes) {
        if ($ids.Contains([int]$entry.ParentProcessId) -and $entry.CreationDate.ToUniversalTime() -ge $started.AddSeconds(-5)) {
            [void]$ids.Add([int]$entry.ProcessId)
        }
    }
} while ($ids.Count -gt $before)
foreach ($entry in $processes | Where-Object { $ids.Contains([int]$_.ProcessId) }) {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)"
    if ($live -and $live.CreationDate -eq $entry.CreationDate) {
        Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
