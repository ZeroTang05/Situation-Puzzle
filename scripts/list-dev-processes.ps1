param(
  [string]$Match,
  [switch]$Kill
)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like ("*" + $Match + "*") } |
  ForEach-Object {
    $summary = $_.CommandLine
    if ($summary.Length -gt 90) { $summary = $summary.Substring(0, 90) }
    Write-Output ("{0}  {1}" -f $_.ProcessId, $summary)
    if ($Kill) { Stop-Process -Id $_.ProcessId -Force }
  }
