param([switch]$Check)
# 找出 DSH 正在监听的端口里，哪一个在服务 dsh-plugin-trim 的面板页。
# DSH 每次启动端口都不同，所以不能写死。
$ErrorActionPreference = 'SilentlyContinue'
$ports = foreach ($p in (Get-Process -Name 'DeepSeek Harness')) {
  foreach ($c in (Get-NetTCPConnection -State Listen -OwningProcess $p.Id)) { $c.LocalPort }
}
foreach ($port in ($ports | Sort-Object -Unique)) {
  $code = & curl.exe -s -o NUL -w '%{http_code}' --noproxy '*' -m 2 -I "http://127.0.0.1:$port/api/plugin-trim/panel"
  if ($code -eq '200') {
    $url = "http://127.0.0.1:$port/api/plugin-trim/panel"
    Write-Host $url
    if (-not $Check) { Start-Process $url }
    exit 0
  }
}
Write-Host '没找到面板：DSH 没在运行，或 dsh-plugin-trim 被禁用了。' -ForegroundColor Red
exit 1