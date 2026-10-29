# 验收脚本

这些脚本会**真实访问 B 站 API 和 CDN、下载视频**，不是离线单元测试。会读取仓库根目录的 `sessdata.txt`（如果有的话）。请把输出目录指向临时文件夹，测完删掉。

| 脚本 | 测什么 | 大概流量 |
|---|---|---|
| `speed_bench.py <输出目录> <秒数> [线程数] [BV号] [分P] [qn]` | 下载一个分P的视频流（默认 1080P，qn 写 120 是 4K），N 秒后取消或下完为止，报告速度和各节点命中次数，用于比较改动前后的速度。默认视频是 BV1Q24y1j7YT 的 P1（约 3 分钟，会很快下完）；要测稳态速度，可以换一个更长的视频 | 最多约 速度 × 秒数 |
| `accept_test.py <输出目录>` | 断点续传（下到一半取消后续传，再用 ffprobe 检查）、签名过期后刷新链接、坏节点降权 | 约 250 MB |
| `hang_test.py <输出目录>` | 把一个一直不响应的 IP 放在节点列表最前面（可选同时让签名过期），检查不会被它卡住 | 约 20 MB |
| `web_test.py <输出目录>` | 需要先启动 `bilidl_web.py --no-browser`。测 Host/token 校验、参数校验、下载、取消、重试、「已存在」、移除 | 约 30 MB |
| `web_skip_test.py <输出目录> [端口]` | 需要先启动服务。用 1 个线程下一个 2P 视频，测跳过排队中/下载中的分P、任务进行中和结束后恢复（续传）、全部跳过、和取消整个任务的区别 | 约 30 MB |
| `web_ext_test.py <输出目录> [端口]` | 需要先启动服务。测 Chrome 插件用到的接口：`/api/token` 的 Origin/Host 校验、`/api/sync_cookie`（不会改动真实 cookie）、记住清晰度、`/?url=` 预填。测完会恢复 `config.json` | 不到 1 MB（下载开始后立刻取消） |
| `web_threads_test.py <输出目录>` | 需要先启动服务。测线程数设置的校验和当前节点显示 | 约 75 MB |
| `node h2_bench.mjs [BV号] [每组秒数] [节点,…]` | 纯插件方案的前提：CDN 按 TCP 连接还是按 HTTP/2 stream 限速。比较 1 条 h2 连接上 1/4/16 个并发请求、4/16 条独立 HTTP/1.1 连接、4 条 h2 连接的速度，并列出各节点解析到的 IP。需要 Node 18+，见 [docs/EXTENSION_ONLY.md](https://github.com/Yangxiamao/bilifast/blob/main/docs/EXTENSION_ONLY.md) | 约 速度 × 每组秒数 × 18 组，几 GB，可以把秒数调小 |
| `node dl_mux_test.mjs <样本目录> [名字…] [--both\|--fmp4] [--no-decode]` | 下载插件（`extension-dl/`）的 mp4 合成，离线：样本目录里每组是 `<名字>.video.m4s`、`<名字>.audio.m4s`（bilidl.py 下载、不合并）和 `<名字>.ref.mp4`（ffmpeg -c copy 的参考）。按 1 MB 分段打乱顺序写入后收尾，和参考比较每个流的 packet 数据哈希、每个 packet 的 pts/dts/时长/大小/关键帧、流参数，再完整解码一遍 | 不联网 |
| `node dl_engine_test.mjs <样本目录> [名字]` | 下载插件的下载引擎，用本地样本模拟 CDN（慢节点、卡住的节点、一半请求出错的节点、签名过期），中途取消后续传，最后和参考比较数据哈希 | 不联网 |
| `node dl_ext_test.mjs <e2e\|resume\|speed\|fsa> [BV号] [分P] [qn] [codec] [--ref 参考.mp4] …` | 无头 Chrome 加载打包好的下载插件，真实下载。`e2e`：下完存进下载目录，和参考比较数据哈希，`--mem` 时记录 Chrome 内存；`resume`：下到 40% 时杀掉 Chrome 进程，重启后检查接着下；`speed`：下 30 秒报告速度（和 `speed_bench.py` 对比）；`fsa`：要人配合，有界面的 Chrome 里选保存目录，检查写入和重启后的授权。会把 `sessdata.txt` 写进临时 profile，测完删除。需要 Node 22+ 和 Chrome | 默认视频 4K 约 330 MB；speed 约 速度 × 秒数 |
| `node dl_seek_test.mjs <文件.mp4>…` | 合成的 mp4 能不能拖动：无头 Chrome 的 `<video>` 跳到 10%/50%/90%/99%，再用 ffmpeg 在同样位置各解一帧 | 不联网 |
| `sub_test.py <输出目录>` | 字幕选择规则和 SRT 格式（离线）、字幕列表多次请求是否一致、下载和跳过已存在、未登录时的提示。第 2、3 步需要登录 | 不到 1 MB |
| `danmaku_test.py <输出目录>` | 多个 protobuf 分段一起转 ASS（离线）、联网下载和跳过已存在、没装 biliass 时的提示。需要先 `python -m pip install biliass` | 约 1 MB |

注意：
- 测试用的视频（`BV1GJ411x7h7`、`BV1Q24y1j7YT`）是写在脚本里的默认值，如果视频失效，需要换成别的 BV 号。
- `web_test.py`、`web_threads_test.py` 和 `web_skip_test.py` 会写入 `config.json`（记住的目录和线程数），测完可以删掉。
- 在 PowerShell 里中文输出可能会乱码，可以把输出重定向到文件再查看。
