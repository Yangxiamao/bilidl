<#
一键启动 bilidl 网页界面（由「一键启动.bat」调用，也可以直接运行）：
  1. 检查 Python 3.10+，没有就询问是否用 winget 自动安装
  2. 检查 ffmpeg，没有就询问是否用 winget 自动安装
  3. 服务已在运行就直接打开浏览器；否则在本窗口里启动服务并打开浏览器，关闭窗口即退出
参数 -NoBrowser：不打开浏览器（测试用）
#>
param([switch]$NoBrowser)
$ErrorActionPreference = "Continue"  # 各步骤自己处理错误；PS 5.1 下 Stop 会把外部程序的 stderr 当成致命错误
$root = $PSScriptRoot
$url = "http://127.0.0.1:8765/"
try { $Host.UI.RawUI.WindowTitle = "bilidl 下载器（关闭此窗口即退出）" } catch {}

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

function Ask($question) {
    $a = Read-Host "$question [Y/n]"
    return ($a -eq "" -or $a -match "^[yY]")
}

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Test-Python($exe, $preArgs) {
    # 应用商店的 python.exe 占位程序不会输出版本信息，这里会得到空结果
    try {
        $out = & $exe @preArgs -c "import sys; print(sys.executable if sys.version_info >= (3, 10) else '')" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -and (Test-Path ($out | Select-Object -Last 1))) { return ($out | Select-Object -Last 1).Trim() }
    } catch {}
    return $null
}

function Find-Python {
    foreach ($c in @(@{exe = "py"; pre = @("-3")}, @{exe = "python"; pre = @()})) {
        if (Get-Command $c.exe -ErrorAction SilentlyContinue) {
            $p = Test-Python $c.exe $c.pre
            if ($p) { return $p }
        }
    }
    # 官方安装包默认不加 PATH，按常见安装位置再找一遍（版本高的优先）
    $dirs = @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles")
    $found = foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem $d -Directory -Filter "Python3*" -ErrorAction SilentlyContinue } }
    foreach ($d in ($found | Sort-Object { [int](($_.Name -replace "\D", "") + "0") } -Descending)) {
        $exe = Join-Path $d.FullName "python.exe"
        if (Test-Path $exe) { $p = Test-Python $exe @(); if ($p) { return $p } }
    }
    return $null
}

function Has-Winget { return [bool](Get-Command winget -ErrorAction SilentlyContinue) }

Say "=== bilidl 下载器 ===" "Cyan"

# 已经在运行（例如设置了开机自启）就直接打开网页
try {
    $r = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
        Say "bilidl 已经在运行，正在打开浏览器：$url" "Green"
        if (-not $NoBrowser) { Start-Process $url }
        Start-Sleep -Seconds 2
        exit 0
    }
} catch {}

# 1. Python
Say "检查 Python…"
$py = Find-Python
if (-not $py) {
    Say "没有找到 Python 3.10 或更高版本。" "Yellow"
    if ((Has-Winget) -and (Ask "现在用 winget 自动安装 Python 3.12 吗？（约 30 MB，需要联网）")) {
        winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        Refresh-Path
        $py = Find-Python
    }
    if (-not $py) {
        Say "请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/" "Red"
        Say "安装时请勾选「Add python.exe to PATH」，装好后重新双击「一键启动.bat」。" "Red"
        exit 1
    }
}
Say "  Python: $py" "Green"

# 2. ffmpeg（用 bilidl 自己的查找逻辑：PATH，再查 winget 的安装目录）
Say "检查 ffmpeg…"
$findFF = "import sys; sys.path.insert(0, sys.argv[1]); import bilidl; print(bilidl.find_ffmpeg() or '')"
$ff = (& $py -I -c $findFF $root 2>$null | Select-Object -Last 1)
if (-not $ff) {
    Say "没有找到 ffmpeg（用来把视频和音频合成 mp4，必须要有）。" "Yellow"
    if ((Has-Winget) -and (Ask "现在用 winget 自动安装 ffmpeg 吗？（约 100 MB，需要联网）")) {
        winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
        Refresh-Path
        $ff = (& $py -I -c $findFF $root 2>$null | Select-Object -Last 1)
    }
    if (-not $ff) {
        Say "暂时没有 ffmpeg：网页可以打开，但下载会在合成 mp4 这一步失败。" "Yellow"
        Say "手动安装方法：在命令行运行 winget install Gyan.FFmpeg，或从 https://ffmpeg.org/download.html 下载。" "Yellow"
    }
}
if ($ff) { Say "  ffmpeg: $ff" "Green" }

# 选择文件夹的对话框需要 tkinter（官方安装包默认带）
& $py -I -c "import tkinter" 2>$null
if ($LASTEXITCODE -ne 0) { Say "提示：这个 Python 没有 tkinter，「浏览…」按钮不可用，可以直接在网页上输入保存路径。" "Yellow" }

if (-not (Test-Path (Join-Path $root "sessdata.txt"))) {
    Say "提示：还没有登录 B 站，最高只能下 480P。在网页右上角点击登录状态，粘贴 SESSDATA 即可登录。" "Yellow"
}

# 3. 在本窗口里运行服务（服务会自动打开浏览器）
Say ""
Say "正在启动，浏览器会自动打开 $url" "Cyan"
Say "使用期间不要关闭这个窗口；关闭窗口即退出（没下完的部分下次会接着下）。" "Cyan"
Say ""
$webArgs = @("-I", (Join-Path $root "bilidl_web.py"))
if ($NoBrowser) { $webArgs += "--no-browser" }
& $py @webArgs
exit $LASTEXITCODE
