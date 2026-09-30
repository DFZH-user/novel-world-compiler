param([Parameter(Mandatory=$true)][string]$PortableExe)
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath $PortableExe)) { throw '便携版文件不存在' }
$testBase=Join-Path ([IO.Path]::GetTempPath()) 'novel-portable-isolation-verification'
New-Item -ItemType Directory -Path $testBase -Force | Out-Null
$started=@()
function Wait-App([int]$parentId,[int]$minutes) {
  $deadline=(Get-Date).AddMinutes($minutes)
  while((Get-Date) -lt $deadline) {
    $child=Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId" | Where-Object { $_.Name -eq '小说世界.exe' } | Select-Object -First 1
    if($child -and $child.ExecutablePath) {
      $dir=Split-Path -Parent $child.ExecutablePath
      $needed=@("$dir\icudtl.dat","$dir\resources\sillytavern\server.js","$dir\resources\sillytavern\node_modules\express\index.js")
      if(@($needed | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0) {
        return [pscustomobject]@{Parent=$parentId;Child=$child.ProcessId;Directory=$dir;Files=$needed}
      }
    }
    Start-Sleep -Seconds 5
  }
  throw "便携版未在 ${minutes} 分钟内完整启动，进程 $parentId"
}
try {
  foreach($i in 1..2) {
    $profile=Join-Path $testBase "profile-$i"
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    $proc=Start-Process -FilePath $PortableExe -PassThru -WindowStyle Hidden -Environment @{NOVEL_COMPILER_USER_DATA=$profile}
    $started+=,$proc
    $info=Wait-App $proc.Id 10
    Write-Output "第 $i 次启动：$($info.Directory)"
    if($i -eq 1){$first=$info}else{$second=$info}
  }
  if($first.Directory -eq $second.Directory) { throw '两次启动仍共用同一个临时目录' }
  foreach($file in $first.Files) { if(-not (Test-Path -LiteralPath $file)){throw "第二次启动清除了第一次的资源: $file"} }
  Write-Output '通过：两个不同目录，第二次启动后第一次的ICU与酒馆资源仍完整。'
} finally {
  foreach($proc in $started) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}
