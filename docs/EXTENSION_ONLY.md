# 只装插件、不用本地程序：可行性验证

## 结论
**可行。** 现在的在线播放加速要靠本机的 bilidl-web（Python）多开 TCP 连接，前提是「CDN 按连接限速」。实测下来更准确的说法是 **CDN 按单个请求（HTTP/2 stream）限速**：在一条 HTTP/2 连接上同时发多个 Range 请求，总速度照样随并发数增长。浏览器本来就用 HTTP/2，所以插件在 bilibili.com 页面里自己并发请求，就能拿到和本地程序差不多的速度。

| | 并发 1 | 并发 4 | 并发 16 |
|---|---|---|---|
| Chrome 156，bilibili.com 页面里 fetch，同一节点（mirrorhwb），**只用 1 条 h2 连接** | 3.8~5.2 MB/s | 16.5~20.5 MB/s | 32~44 MB/s |
| 对照：Node，16 条独立的 HTTP/1.1 连接（相当于现在的 Python 下载器） | – | 19~20 MB/s | 49~57 MB/s |

4K 平均码率约 2 MB/s，2 倍速约 4 MB/s；并发 4 就有 4 倍以上的余量。

播放器那一侧也能接管：B 站播放器现在**在主线程用 XHR** 取视频分段（`core.*.js`，没有建 Worker）。页面脚本运行前替换 `XMLHttpRequest`，把每个 `.m4s` 的 Range 请求拆成 4 份并发取、拼好后交还给播放器，**视频照常播放**：30 个分段请求全部由我们返回，没有一次退回原请求，播放器自己不再连 cosov / akamai。

这意味着：
- 不需要 127.0.0.1，不需要 Chrome 的「本地网络访问」授权，不需要开着黑窗口；
- 插件的请求从 bilibili.com 页面发出，CDN 本来就放行这个来源的 CORS，**插件连 upos 的 host 权限都不需要**（对上架 Chrome Web Store 友好）。

## 实测（2026-10-29，作者的网络，游客身份）

### 1. 限速粒度：`tests/h2_bench.mjs`
BV1bE41127s6 P1 的 4K 视频流，每个请求 1 MB Range，每组 8 秒（MB/s）：

| 节点 | A：1 连接 × 1 stream | B4：1 连接 × 4 | B16：1 连接 × 16 | C4：4 条 HTTP/1.1 | C16：16 条 HTTP/1.1 | D：4 条 h2 × 4 |
|---|---|---|---|---|---|---|
| mirror08ct | 4.25 | 17.6 | 20.1 | 19.0 | 53.4 | 48.0 |
| mirrorhwb | 3.13 | 17.5 | 40.3 | 19.6 | 52.5 | 44.4 |
| mirrorhw | 5.16 | 19.9 | 31.2 | 19.8 | 48.7 | 46.4 |

- 1 连接 × 4 stream ≈ 4 条独立连接，说明限速单位是请求，不是 TCP 连接。16 个 stream 时单连接开始受 TCP 本身（拥塞窗口、丢包）的限制，比 16 条连接低一些，但对播放来说绰绰有余。
- 坑：Node 的 `http2` 默认流控窗口只有 64 KB，第一次测出来单连接只有 0.3~0.6 MB/s、加 stream 也不涨，差点得出相反的结论。按 Chrome 的设置（stream 6 MB、连接 15 MB）放大窗口后才是上表的数字。
- 单连接速度比 docs/PLAYBACK.md 里 10-27 测的（约 1.2 MB/s）高了 3~4 倍，同一天里节点速度也常变，所以绝对值只能参考，比例关系才是结论。
- 全部节点都协商到 h2，响应里没有 `alt-svc`（不走 HTTP/3）。mirror08ct 和 mirrorhw 解析到同一组 IP，浏览器可能把它们合并成一条连接，但既然按请求限速，这不影响速度。

### 2. 真实 Chrome：`tests/chrome_spike.mjs`
无头 Chrome 156、临时 profile，打开视频页，在页面里跑并发 fetch，并用 CDP 记录每个响应的 `connectionId`：

| 测试 | 速度 | 实际连接 |
|---|---|---|
| mirrorhwb 并发 1 | 3.8~5.2 MB/s | 1 条 h2 |
| mirrorhwb 并发 4 | 16.5~20.5 MB/s | 同一条 |
| mirrorhwb 并发 16 | 32~44 MB/s | 同一条 |
| 3 个节点轮流，并发 16 | 15~31 MB/s | 每个节点 1 条 |

几次跑下来，多节点轮流反而不如单个快节点稳定：会被最慢的那个拖住。以后挑节点还是要按实测速度来（沿用 bilidl_play.py 的做法）。

### 3. 播放器怎么取数据、能不能接管
- 播放器没有创建 Worker，所有 `.m4s` 分段请求都是 `core.*.js` 在主线程发出的 XHR，`responseType = "arraybuffer"`，带 `Range: bytes=a-b` 头。docs/PLAYBACK.md 里 10-27 记录的是「在 Worker 里用 XHR」，B 站的播放器两天内就变了，所以**接管代码必须对两种情况都能工作，认不出的请求一律原样放行**。
- 不接管时：播放器连 `mirrorcosov`（h2）和 `akamai`（HTTP/1.1 / h3）。
- 接管时（`--takeover`）：打开页面 25 秒，接管 30 个分段请求、2.4 MB（游客 360P），平均每个 133 ms，0 次退回；视频播放到 18 秒、缓冲到 60 秒，没有报错；播放器自己不再连 cosov / akamai。
- 接管的写法：继承 `XMLHttpRequest`，在 `send` 里自己 `fetch`，完成后用 `Object.defineProperty` 在实例上覆盖 `readyState` / `status` / `response`，再依次派发 `readystatechange`、`progress`、`load`、`loadend`。播放器调用 `abort()` 时取消自己的 fetch。任何一步出错就调用原来的 `send`，等于退回直连。

## 没验证的（做正式版时要测）
- 登录后的 4K / 倍速 / 跳转 / 长时间播放；正式版要把 bilidl_play.py 的分块缓存、两级优先级、2.5 秒对冲、按实测速度挑节点、倍速自适应预读窗口移植成 JS，用 play_bench 那套场景重新比较。
- 插件里 `"world": "MAIN"`、`document_start` 的内容脚本能否保证早于播放器脚本运行（CDP 的 `addScriptToEvaluateOnNewDocument` 是保证的）。
- 番剧页、列表页、嵌入播放器。
- 多个标签页各自缓存时的内存占用（每个标签页一份，不再是全局 800 MB）。

## 对整体方案的影响
- **在线播放加速**：改成纯插件。去掉 DNR 重定向、`/play/` 代理、本地网络访问授权和 bilidl-web 依赖。
- **下载**（用户决定也搬进插件）：请求能力已经验证了；还要解决的是
  - 把 DASH 的视频、音频两个 fMP4 合成一个 mp4（替代 ffmpeg `-c copy`，纯 JS 改写 box，不引入几十 MB 的 ffmpeg.wasm）；
  - 大文件写盘：4K 视频可达 8 GB，要用 File System Access API 边下边写，不能整个放在内存里；断点续传也基于它；
  - 字幕转 SRT（简单）、弹幕转 ASS（要自己实现，替代 biliass）。
- **上架 Chrome Web Store**：需要的权限很少（bilibili.com 上的内容脚本；下载功能再加 `downloads` 或文件系统访问），没有远程代码。下载类功能有审核风险，可以考虑「播放加速」和「下载」分成两个插件，先上架加速版。
