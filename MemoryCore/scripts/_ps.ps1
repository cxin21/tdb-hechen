Get-Process node -ErrorAction SilentlyContinue | Select-Object -First 8 Id,StartTime | Format-Table -AutoSize | Out-String
