param([switch]$Check)
# dsh-plugin-trim 固定端口面板：http://127.0.0.1:12256/
# 端口被占时插件会自己往后顺延，所以这里保留一条回退：扫 DSH 端口找老式路径。
$ErrorActionPreference = 'SilentlyContinue'
$fixed = 'http://127.0.0.1:12256/'

$code = & curl.exe -s -o NUL -w '%{http_code}' --noproxy '*' -m 2 $fixed
if ($code -eq '200') {
  Write-Host $fixed
  if (-not $Check) { Start-Process $fixed }
  exit 0
}

# 回退：扫 DeepSeek Harness 的监听端口，找挂载了 /api/plugin-trim/panel 的那一个
$ports = foreach ($p in (Get-Process -Name 'DeepSeek Harness')) {
  foreach ($c in (Get-NetTCPConnection -State Listen -OwningProcess $p.Id)) { $c.LocalPort }
}
foreach ($port in ($ports | Sort-Object -Unique)) {
  $probe = & curl.exe -s -o NUL -w '%{http_code}' --noproxy '*' -m 2 -I "http://127.0.0.1:$port/api/plugin-trim/panel"
  if ($probe -eq '200') {
    $url = "http://127.0.0.1:$port/api/plugin-trim/panel"
    Write-Host $url
    if (-not $Check) { Start-Process $url }
    exit 0
  }
}

Write-Host '没找到面板：DSH 没在运行，或 dsh-plugin-trim 被禁用了。' -ForegroundColor Red
exit 1