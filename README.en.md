# bilidl

[中文](README.md) | **English** | [日本語](README.ja.md)

**A bilibili video downloader: saves videos as mp4 with multi-threaded, resumable downloads, plus optional subtitles and danmaku.** On Windows it runs with a double-click and comes with a web UI.

<p align="center"><img src="docs/images/web-ui.png" alt="bilidl web UI: after parsing a video, pick a quality (with estimated sizes), select parts, choose the save folder and thread count" width="760"></p>

## Install (Windows)

1. Download `bilidl-vX.Y.Z.zip` from [Releases](https://github.com/Yangxiamao/bilidl/releases/latest) and unzip it anywhere.
2. Double-click `一键启动.bat` ("one-click start"). On first run, if Python or ffmpeg is missing, it asks whether to install them for you (press Enter to accept).
3. Your browser opens the download page: paste a video link → parse → choose quality and save location → start.

Keep the black console window open while using it. 720P and above require [logging in](docs/DOWNLOADER.md#登录720p-及以上需要). To download with one click from bilibili video pages, also install the [download extension](docs/DOWNLOADER.md#chrome-插件在-b-站视频页一键下载).

## Features

- **Fast**: multi-threaded chunked downloads, switched to faster CDN nodes. On the author's network this goes from about 2 MB/s to about 24 MB/s.
- **Resumable**: close it midway and it picks up where it left off next time.
- **One mp4 per part**: video and audio are merged with ffmpeg, no re-encoding.
- **Subtitles and danmaku**: optionally download subtitles (.srt) and danmaku (.ass), or subtitles only.
- **Command line**: `python bilidl.py BV1xxxxxxxxx -q 1080 -o D:\Videos`

Full documentation (in Chinese: CLI options, web UI, autostart, security design, how the speed-up works): [docs/DOWNLOADER.md](docs/DOWNLOADER.md).

## Just want smooth online playback?

If bilibili's web player stalls on 4K or fast playback speeds, use [bilifast](https://github.com/Yangxiamao/bilifast) by the same author. It's a standalone Chrome extension and needs nothing from this repo.

## Disclaimer

For personal study and for backing up content you are entitled to watch. Video copyright belongs to the original creators. Follow bilibili's terms of service and don't redistribute downloaded content. This project is not affiliated with bilibili.

[MIT License](LICENSE). The optional danmaku dependency biliass is GPL-3.0 and is not bundled in this repo.
