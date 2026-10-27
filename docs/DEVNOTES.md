# 开发笔记

记录开发过程中确认过的事实、核心 API 和网页界面的设计，方便以后维护。提速相关的测量数据和设计见 [SPEEDUP.md](SPEEDUP.md)。

## 踩过的坑

- **主站不稳定**：www.bilibili.com 有时会 SSL 握手超时，而 api.bilibili.com 和 CDN 一直能连上。所以 bilidl 只依赖 API 和 CDN，主站只用来兜底取标题。
- **412 风控**：
  - 请求 API 时必须带上游客 cookie `buvid3`/`buvid4`（从 `/x/frontend/finger/spi` 获取），否则会返回 412。
  - `/x/web-interface/view` 带 SESSDATA 请求时很容易被 412；请求多了之后，连游客身份也会被 412，应该是 IP 级别的临时风控。
  - 处理方式：先用游客身份请求 view；失败就改用 `/x/player/pagelist` 获取分P列表，再从主站网页的 `<title>` 里取标题。
  - 取标题时要注意：网页是 gzip 压缩的；标题后面不一定带「_哔哩哔哩」；要做 HTML 反转义；主站返回错误页时，标题会是「视频去哪了呢？」，这时改用 BV 号当标题。
  - 一些现成的下载工具（例如 BBDown 1.6.3）就是卡在 view 接口的 412 上。
- **清晰度权限**：游客最高 480P，登录后可以下 720P/1080P，1080P60 及以上需要大会员。
- **字幕**：游客拿不到任何字幕；不签名的 `/x/player/v2` 偶尔返回别的视频的 AI 字幕，要用带 WBI 签名的 `/x/player/wbi/v2`。详见 [SUBTITLES.md](SUBTITLES.md)。
- **CDN**：
  - 每个连接下载 1~2 MB 后会被服务器断开，所以按 1 MB 分段，用 Range 请求，失败后自动重试。
  - 签名链接会过期，遇到 403/404 时要重新请求 playurl 刷新链接。
  - 每个连接单独限速，详见 SPEEDUP.md。
  - 节点会下线、速度也常变（08c 在 2026-10 已解析不到）；网页播放器的请求全走一条 HTTP/2 连接，所以在线播放会卡。详见 [PLAYBACK.md](PLAYBACK.md)。
- **urllib 的 timeout**：超时是按每个解析出的 IP 分别计算的。CDN 域名往往有多个 IP，一个不通的节点可能卡住 100 多秒。所以获取文件大小时要同时请求所有节点。
- **Windows / PowerShell**：
  - 用 `python -c "..."` 传复杂代码时，PowerShell 会吃掉其中的引号，最好写成 .py 文件再运行。
  - 控制台和 `*>` 重定向会把中文变成乱码（GBK）。要看中文输出，就让 Python 写入 UTF-8 文件再读。
  - `python -I`（隔离模式）不会把脚本所在目录加入 `sys.path`，所以 `bilidl_web.py` 里要手动执行 `sys.path.insert(0, HOME)`。
  - `pythonw` 运行时 `sys.stdout` 是 `None`，日志要改写到文件。
  - 在 Windows 上，`SO_REUSEADDR` 会允许两个进程绑定同一个端口，所以要改用 `SO_EXCLUSIVEADDRUSE`。
  - **路径长度限制 260**：长度按 UTF-16 计算，`𝟰𝗞` 这类花体字符每个算 2 个单位。如果视频标题很长，既用作文件夹名、又出现在分P文件名里，再加上 `.video.m4s.state.json.tmp` 后缀，很容易超过上限，这时会报 `FileNotFoundError`（实测遇到过）。所以 `output_layout()` 会按路径总长度截断名字，并去掉名字末尾的点和空格。

## 核心 API（bilidl.py）

- `Api()`：自动获取游客 buvid，并读取 `sessdata.txt`。`api.get(url, login=True)` 发送请求，`api.nav()` 返回 `{login, vip, uname}`。
- `resolve_target(s)`：输入 BV 号、视频链接或 b23.tv 短链，返回 `(bvid, page 或 None)`。
- `video_meta(api, bvid)`：返回 `(title, owner, [(page, part, cid, duration_s), ...])`。
- `probe_bitrates(api, bvid, pages, max_probe=8)`：抽样前几个分P，返回 `({qn: (名称, 编码, 分辨率, kbps)}, audio_kbps)`。各清晰度的大小按「码率 × 时长」估算。
- `output_layout(title, n_total, out_root)`：返回 `(folder, name_fn)`。多P视频放进以标题命名的子文件夹，每P一个 mp4；单P视频直接放在 out_root。
- `mirrors(s, hosts=None)`：把 upos 链接换成 `FAST_HOSTS` 里的节点，排在前面；API 返回的原始链接放在最后兜底。
- `download_page(api, bvid, cid, folder, name, qn, codec="avc", ffmpeg=None, cancel=None, log=fn, on_streams=fn, on_stage=fn, workers=16, hosts=None)`：
  - 下载并封装一个分P，返回 `(mp4 路径, 实际清晰度名)`；文件已存在时返回 `(路径, None)`。
  - `Stream` 对象的 `.label/.size/.done/.net/.host/.status` 字段会在下载线程里实时更新，网页服务直接读取它们来计算进度和速度。`.net` 只统计这次实际从网络下载的字节，续传时已有的部分不算在内。
  - 调用 `cancel.set()` 后会抛出 `Cancelled`。
  - 断点续传：进度记录在 `*.m4s.state.json` 里，原子写入；新建文件后会立刻写一次，防止进程被强杀后，内容全是 0 的文件被当成已经下完。
- 字幕：
  - `api.wbi_query(params)`：返回带 WBI 签名的 query 字符串，密钥缓存 1 小时。
  - `list_subtitles(api, bvid, cid)`：返回 `[{lan, name, url, ai, translated}]`。
  - `select_subtitles(subs, spec)`：`spec` 是 `auto` / `all` / 逗号分隔的语言代码。
  - `download_subtitles(api, bvid, cid, folder, name, spec, duration, log)`：存成 `<name>.<lan>.srt`，返回 `(已保存的语言, 说明)`。没有字幕不抛异常，说明里写原因；已存在的 .srt 不重新下载。
- 其他：`QUALITY`（命令行清晰度名 → qn）、`QN_NAME`、`find_ffmpeg()`、`parse_pages()`。

## 网页界面（bilidl_web.py）

浏览器不能写入任意文件夹，也绕不过 B 站 CDN 的 Referer 校验，所以做成「本地服务 + 网页」的形式。

- **服务**：标准库 `ThreadingHTTPServer`，只监听 `127.0.0.1:8765`。如果端口已被占用，就认为已有实例在运行，直接打开浏览器。
- **安全**：
  - 启动时随机生成一个 token，嵌进返回的 HTML 里，所有 `/api/*` 请求都必须带上 `X-Token` 请求头。
  - 校验 `Host` 请求头，防止 DNS rebinding。
  - 页面加了 CSP 和 `X-Frame-Options`。
  - `/api/open` 只能打开任务的保存目录或用户选过的目录。
  - 不记录请求日志。
- **选择文件夹**：用子进程运行 tkinter 的 `filedialog.askdirectory`（窗口置顶），选中的路径通过 stdout 传回。
- **接口**：
  - `GET /api/status`、`GET /api/jobs`
  - `POST /api/info`：解析结果按 bvid 缓存
  - `POST /api/download`：`subs` 是 `off` / `auto` / `all`，`sub_only` 为真时只下字幕
  - `POST /api/cancel`、`/api/retry`、`/api/remove`、`/api/pick_folder`、`/api/open`、`/api/cookie`
  - `POST /api/skip`、`/api/unskip`：参数 `{id, page}`，跳过/恢复任务里的一个分P
  - `GET /api/token`：给 Chrome 插件取 token，不需要 `X-Token`。校验 Host；带 `Origin` 但不是 `chrome-extension://` 时 403
  - `POST /api/sync_cookie`：参数 `{sessdata}`，和当前的相同时返回 `{changed: false}`（不联网、不清解析缓存），不同时走 `/api/cookie` 的逻辑
  - `GET /api/status` 返回 `qn`：上次下载视频用的清晰度（只下字幕时不记），网页和插件都默认选它
- **网页预填**：`/?url=<链接>` 会自动填进输入框并解析，然后用 `history.replaceState` 把地址改回 `/`，刷新时不重复解析。插件的「更多选项」用的就是这个。
- **任务队列**：只有一个工作线程，一次只下一个任务，任务内逐个分P下载。同一个文件已经在未结束的任务里时，拒绝重复提交。
- **跳过分P**：
  - 每个分P有自己的 `cancel` 事件，传给 `download_page`；取消整个任务时也会设置正在下载的那个分P的事件。打断后，`job.cancel` 被设置了就记为 `cancelled`（「重试」会重下），没设置就记为 `skipped`（「重试」不管，只能单独恢复）。
  - `run_job` 每次都重新找第一个 `queued` 的分P，而不是按顺序遍历一遍，这样任务进行中恢复的分P（包括排在当前分P前面的）也会下载。找不到时在 `LOCK` 里直接设置任务的结束状态，避免和 `/api/unskip` 抢着改状态。
  - 跳过的分P不计入任务的进度和总大小；`finish_status` 也不考虑它们，全部跳过时任务算「已取消」。
- **字幕**：每个分P先下字幕再下视频；字幕失败只记在 `sub_msg` 里，不影响视频。解析时只查一个分P的字幕给用户参考，下载时每个分P单独查。单P任务看不到分P行，所以任务这一级也显示字幕结果。
- **进度**：
  - 任务总大小 = 已知的流实际大小 + 尚未开始的部分按码率估算的大小。
  - 速度由采样线程每秒对 `Stream.net` 取样，用最近约 5 秒的增量计算。
  - 剩余时间 = 剩余字节 ÷ 速度。
  - 前端每秒轮询一次，按任务 id 原地更新 DOM，不整块重绘，否则按钮会点不到。
- **后台运行**：`install-autostart.ps1` 在「启动」文件夹里创建快捷方式，用 `pythonw ... --no-browser` 运行。token 在每次打开页面时注入，所以书签不会失效。改了 `bilidl_web.html` 只需刷新页面；改了 .py 文件则需要重新运行 `install-autostart.ps1`，它会先停掉旧服务再启动。

## Chrome 插件（chrome-extension/）

MV3，开发者模式加载。只做界面，解析和下载都交给本地服务。

- **请求必须走后台**：内容脚本运行在 bilibili.com 的源下，直接请求 `127.0.0.1` 会被 CORS 和 Chrome 的私有网络访问（PNA）限制拦掉。所以内容脚本通过 `chrome.runtime.sendMessage` 让 `background.js` 去请求；后台有 `host_permissions`，不受 CORS 限制。
- **token**：后台用 `/api/token` 取并缓存；服务重启后 token 会变，收到「token 无效」的 403 时清掉缓存重取一次。fetch 失败就认为服务没运行。
- **登录同步**：`chrome.cookies` 能读到 HttpOnly 的 `SESSDATA`。每次点开面板都调一次 `/api/sync_cookie`，值没变时服务端直接返回，开销很小。
- **按钮位置**：固定在页面右下角，不插进 B 站工具栏，因为 B 站改版时 DOM 选择器容易失效。按钮和面板放在 closed Shadow DOM 里，不受 B 站样式影响。
- **单页跳转**：B 站切换分P、点推荐视频时不刷新页面，所以视频链接要在点击按钮时读 `location.href`，不能在脚本加载时读。
- **面板状态**：每次打开面板 `session` 加一，旧的请求结果和进度轮询发现 `session` 变了就作废，避免关掉再打开时内容串在一起。
- **测试**：`tests/web_ext_test.py` 测服务端接口；面板本身只能在浏览器里手动测。

## 设计取舍

- 下载时集中带宽：一个分P下完再下下一个，这样用户能更早看到完整的文件。
- 每个分P单独存成 mp4，不把多个分P拼成一个文件；音频和视频用 `ffmpeg -c copy` 封装，不重新编码。
- 默认 720P：1080P 的体积约为 720P 的 2.6 倍。界面上会显示各清晰度的大小对比，让用户自己选。

## 测试情况

验收脚本见 `tests/`。已验证：
- 命令行下载和 `--info`。
- 取消后续传：只下剩下的分段，最终文件用 ffprobe 检查过。
- 签名过期后自动刷新链接。
- 不存在或不响应的节点会被降权，不会卡住下载。
- 网页接口：
  - token 和 Host 校验；
  - 参数校验；
  - 下载、取消、重试、「已存在」、移除；
  - 任务进行中跳过/恢复分P（排队中的、下载中的、任务结束后再恢复并续传）；
  - 线程数设置和当前节点显示。
- 后台运行（pythonw + 开机自启快捷方式）。

还没有自动化测试的：浏览器里的界面效果和深色模式、tkinter 选择文件夹对话框、「打开文件夹」、通过网页更新 cookie 的成功路径、命令行按 Ctrl+C 后的续传（和取消走的是同一个保存分支）。
