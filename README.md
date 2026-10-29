# bilidl

**中文** | [English](README.en.md) | [日本語](README.ja.md)

**B 站视频下载器：把视频存成 mp4，多线程下载、断点续传，还能一起下字幕和弹幕。** Windows 上双击就能用，带网页界面。

<p align="center"><img src="docs/images/web-ui.png" alt="bilidl 网页界面：解析视频后选择清晰度（显示各档估算大小）、勾选分P、选择保存目录和线程数" width="760"></p>

## 安装（Windows）

1. 到 [Releases](https://github.com/Yangxiamao/bilidl/releases/latest) 下载 `bilidl-vX.Y.Z.zip`，解压到任意文件夹。
2. 双击里面的 `一键启动.bat`。第一次运行时如果电脑上没有 Python 或 ffmpeg，会问你是否自动安装（按回车同意）。
3. 浏览器会自动打开下载页面：粘贴视频链接 → 解析 → 选清晰度和保存位置 → 开始下载。

使用期间不要关掉那个黑色窗口。720P 及以上需要先[登录](docs/DOWNLOADER.md#登录720p-及以上需要)。想在 B 站视频页上点一下就下载，再装上[下载插件](docs/DOWNLOADER.md#chrome-插件在-b-站视频页一键下载)。

## 功能

- **快**：多线程分段下载，并换到更快的 CDN 节点。在作者的网络下从约 2 MB/s 提到约 24 MB/s。
- **断点续传**：中途关掉，下次接着下。
- **每个分 P 一个 mp4**：音视频用 ffmpeg 合在一起，不重新编码。
- **字幕和弹幕**：可选一起下载字幕（.srt）和弹幕（.ass），也可以只下字幕。
- **命令行**：`python bilidl.py BV1xxxxxxxxx -q 1080 -o D:\Videos`

完整说明（命令行参数、网页界面、开机自启、安全设计、提速原理）见 [docs/DOWNLOADER.md](docs/DOWNLOADER.md)。

## 只想在线看不卡？

在 B 站网页上看 4K、开倍速卡顿的话，用同作者的 [bilifast](https://github.com/Yangxiamao/bilifast) 播放加速插件。它只是一个 Chrome 插件，不需要这里的任何程序。

## 声明

仅供个人学习和备份自己有权观看的内容。视频版权归原作者所有，请遵守 B 站用户协议，不要传播下载的内容。本项目和 B 站官方无关。

[MIT License](LICENSE)。下载弹幕用到的可选依赖 biliass 是 GPL-3.0，没有打包在本仓库里。
