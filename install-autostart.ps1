<#
安装或取消 bilidl-web 开机自启：在「启动」文件夹里创建一个快捷方式，用 pythonw 在后台无窗口运行。
用法:
  powershell -ExecutionPolicy Bypass -File install-autostart.ps1          安装并立即启动
  powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove  取消自启并停止后台服务
#>
param([switch]$Remove)
$ErrorActionPreference = "Stop"
$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "bilidl-web.lnk"
$script = Join-Path $PSScriptRoot "bilidl_web.py"

function Stop-BilidlWeb {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
        Where-Object { $_.CommandLine -like "*bilidl_web.py*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Confirm:$false; "已停止后台服务 (PID $($_.ProcessId))" }
}

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk -Confirm:$false; "已删除 $lnk" } else { "没有找到开机自启快捷方式" }
    Stop-BilidlWeb
    return
}

# 找到真实的 Python 安装目录（PATH 里的 python 可能是应用商店的占位程序）
$exe = (& python -c "import sys; print(sys.executable)").Trim()
if (-not $exe -or -not (Test-Path $exe)) { throw "找不到 Python，请先安装 Python 3.10+ 并加入 PATH" }
$pyw = Join-Path (Split-Path $exe) "pythonw.exe"
if (-not (Test-Path $pyw)) { throw "找不到 pythonw.exe：$pyw" }

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $pyw
$s.Arguments = "-I `"$script`" --no-browser"
$s.WorkingDirectory = $PSScriptRoot
$s.Description = "bilidl 网页界面后台服务 http://127.0.0.1:8765/"
$s.Save()
"已创建 $lnk"

Stop-BilidlWeb  # 先停掉旧的后台服务（可能来自别的目录），再用新路径启动
Start-Process -FilePath $lnk
Start-Sleep -Seconds 2
try {
    $code = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8765/" -TimeoutSec 5).StatusCode
    "服务已在后台运行：http://127.0.0.1:8765/ （HTTP $code）。把这个网址存成书签即可。"
} catch {
    "服务没有响应，请查看日志：$(Join-Path $PSScriptRoot 'bilidl-web.log')"
}
