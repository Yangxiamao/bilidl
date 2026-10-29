# 验收脚本

这些脚本会**真实访问 B 站 API 和 CDN、下载视频**，不是离线单元测试。会读取仓库根目录的 `sessdata.txt`（如果有的话）。请把输出目录指向临时文件夹，测完删掉。

| 脚本 | 测什么 | 大概流量 |
|---|---|---|
| `speed_bench.py <输出目录> <秒数> [线程数] [BV号] [分P]` | 下载一个分P的 1080P 视频流，N 秒后取消或下完为止，报告速度和各节点命中次数，用于比较改动前后的速度。默认视频是 BV1Q24y1j7YT 的 P1（约 3 分钟，会很快下完）；要测稳态速度，可以换一个更长的视频 | 最多约 速度 × 秒数 |
| `accept_test.py <输出目录>` | 断点续传（下到一半取消后续传，再用 ffprobe 检查）、签名过期后刷新链接、坏节点降权 | 约 250 MB |
| `hang_test.py <输出目录>` | 把一个一直不响应的 IP 放在节点列表最前面（可选同时让签名过期），检查不会被它卡住 | 约 20 MB |
| `web_test.py <输出目录>` | 需要先启动 `bilidl_web.py --no-browser`。测 Host/token 校验、参数校验、下载、取消、重试、「已存在」、移除 | 约 30 MB |
| `web_skip_test.py <输出目录> [端口]` | 需要先启动服务。用 1 个线程下一个 2P 视频，测跳过排队中/下载中的分P、任务进行中和结束后恢复（续传）、全部跳过、和取消整个任务的区别 | 约 30 MB |
| `web_ext_test.py <输出目录> [端口]` | 需要先启动服务。测 Chrome 插件用到的接口：`/api/token` 的 Origin/Host 校验、`/api/sync_cookie`（不会改动真实 cookie）、记住清晰度、`/?url=` 预填。测完会恢复 `config.json` | 不到 1 MB（下载开始后立刻取消） |
| `web_threads_test.py <输出目录>` | 需要先启动服务。测线程数设置的校验和当前节点显示 | 约 75 MB |
| `node h2_bench.mjs [BV号] [每组秒数] [节点,…]` | 纯插件方案的前提：CDN 按 TCP 连接还是按 HTTP/2 stream 限速。比较 1 条 h2 连接上 1/4/16 个并发请求、4/16 条独立 HTTP/1.1 连接、4 条 h2 连接的速度，并列出各节点解析到的 IP。需要 Node 18+，见 [docs/EXTENSION_ONLY.md](../docs/EXTENSION_ONLY.md) | 约 速度 × 每组秒数 × 18 组，几 GB，可以把秒数调小 |
| `node chrome_spike.mjs [BV号] [每组秒数] [--takeover]` | 用临时 profile 启动无头 Chrome（游客），记录播放器从哪里发 m4s 请求；`--takeover` 时在页面里接管这些请求、拆成并发 fetch 交还给播放器，看视频能否照常播放；再在页面里测并发 fetch 的速度和实际连接数。需要 Node 22+ 和 Chrome | 约 1 GB |
| `node play_engine_test.mjs` | 播放加速插件（`extension-play/`）的缓存和调度，用假的 CDN 离线测：各种 Range、同一块只拉一次、只给 akamai 链接时换节点、慢节点对冲、全部出错时抛异常（退回直连）、取消、预读和跳转、内存上限 | 不联网 |
| `node play_ext_test.mjs [correct\|bench\|player\|nav\|all] [BV号] [low\|mid\|high] [--only-on]` | 无头 Chrome 加载打包好的播放加速插件（会先运行 `tools/build_ext.mjs`），打开真实视频页。`correct`：接管的 XHR 和直连逐字节比较、认不出的请求原样放行、插件的请求全部失败时退回直连；`bench`：在页面里模拟播放器（一次取一个约 2 秒的分段，缓冲到 72 秒停；1x → 2x → 跳到 60% → 3x），比较插件关闭和开启的卡顿；`player`：真实播放器按同样的阶段变速、跳转，统计 `waiting`。`nav`：番剧页、列表页、切换分P、切换清晰度（用播放器自己的 `next()`、`requestQuality()`），检查都被接管、不退回直连、切换后不卡、旧的流不再继续预读。会把 `sessdata.txt` 写进临时 profile 以拿到 4K，测完删除。需要 Node 22+ 和 Chrome | correct 约 50 MB，bench 约 1~1.5 GB，player 视画质而定，nav 约 1 GB |
| `sub_test.py <输出目录>` | 字幕选择规则和 SRT 格式（离线）、字幕列表多次请求是否一致、下载和跳过已存在、未登录时的提示。第 2、3 步需要登录 | 不到 1 MB |
| `danmaku_test.py <输出目录>` | 多个 protobuf 分段一起转 ASS（离线）、联网下载和跳过已存在、没装 biliass 时的提示。需要先 `python -m pip install biliass` | 约 1 MB |

注意：
- 测试用的视频（`BV1GJ411x7h7`、`BV1Q24y1j7YT`）是写在脚本里的默认值，如果视频失效，需要换成别的 BV 号。
- `web_test.py`、`web_threads_test.py` 和 `web_skip_test.py` 会写入 `config.json`（记住的目录和线程数），测完可以删掉。
- 在 PowerShell 里中文输出可能会乱码，可以把输出重定向到文件再查看。
