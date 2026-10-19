# Transfer photos/ to the Linux box in year/month chunks (resumable per chunk).
$ErrorActionPreference = 'Continue'
$local  = 'D:\老电脑里的\icloud\photos'
$remote = '/home/mc/photoviewer/photos'
$log    = 'D:\老电脑里的\icloud\photoviewer\transfer.log'

function Log($msg) {
    $line = "[" + (Get-Date -Format 'HH:mm:ss') + "] " + $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Output $line
}

Set-Location $local
Log "start photos -> $remote"

$chunks = @('2008','2013','2017','2018','2020','2021','2022','2023','2024')
foreach ($m in 1..12) { $chunks += ('2025/{0:D2}' -f $m) }

foreach ($c in $chunks) {
    $src = Join-Path $local $c
    if (-not (Test-Path $src)) { Log "skip $c (not present locally)"; continue }

    $localCount = (Get-ChildItem $src -Recurse -File).Count
    $remoteRaw  = ssh -o BatchMode=yes mc ("find " + $remote + "/" + $c + " -type f 2>/dev/null | wc -l")
    $remoteCount = 0
    if ($remoteRaw) { $remoteCount = [int]("$remoteRaw".Trim()) }

    if ($remoteCount -eq $localCount -and $localCount -gt 0) {
        Log ("skip {0} (remote already has {1} files)" -f $c, $localCount)
        continue
    }

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $cmdLine = 'tar -cf - ' + $c + ' | ssh -o BatchMode=yes mc "tar -xf - -C ' + $remote + '"'
    cmd /c $cmdLine
    $rc = $LASTEXITCODE
    $sz = [math]::Round((Get-ChildItem $src -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
    $afterRaw = ssh -o BatchMode=yes mc ("find " + $remote + "/" + $c + " -type f 2>/dev/null | wc -l")
    Log ("{0,-8} local={1,5} {2,6} GB {3,5:N0}s rc={4} remote={5}" -f $c, $localCount, $sz, $sw.Elapsed.TotalSeconds, $rc, "$afterRaw".Trim())
}

Log "transfer finished"
$du = ssh -o BatchMode=yes mc ("du -sh " + $remote + "; find " + $remote + " -type f | wc -l")
foreach ($l in $du) { Log ("  " + $l) }
