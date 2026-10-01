param([Parameter(Mandatory=$true)][string]$PortableExe)
$ErrorActionPreference = 'Stop'
$profile = Join-Path (Split-Path -Parent $PSScriptRoot) '.portable-smoke\profile'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$env:NOVEL_COMPILER_USER_DATA = $profile
$existing = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '小说世界.exe' } | ForEach-Object { $_.ProcessId })
$parent = $null
$lastObserved = '未发现新应用进程'
try {
  $parent = Start-Process -FilePath $PortableExe -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    $children = @(Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq '小说世界.exe' -and $existing -notcontains $_.ProcessId
    })
    foreach ($child in $children) {
      if (-not $child.ExecutablePath) { continue }
      $dir = Split-Path -Parent $child.ExecutablePath
      $needed = @("$dir\icudtl.dat", "$dir\resources\sillytavern\server.js",
        "$dir\resources\sillytavern\node_modules\express\index.js",
        "$dir\resources\sillytavern\default\config.yaml")
      $lastObserved = "进程 $($child.ProcessId) 位于 $dir，缺少 $(@($needed | Where-Object { -not (Test-Path -LiteralPath $_) }) -join ', ')"
      if (@($needed | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0) {
        Write-Output "便携版启动成功，完整资源位于 $dir"
        exit 0
      }
    }
    Start-Sleep -Seconds 3
  }
  throw "便携版启动后未检测到完整的内置游玩资源：$lastObserved"
} finally {
  if ($parent) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -eq '小说世界.exe' -and $existing -notcontains $_.ProcessId
    } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $parent.Id -Force -ErrorAction SilentlyContinue
  }
}
