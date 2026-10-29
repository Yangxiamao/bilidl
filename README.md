# bilidl

B 站（bilibili）网页播放加速插件 + 视频下载器。两部分互相独立，按需要装：

- **播放加速（Chrome 插件，主打）**：在 B 站网页上看 4K、开倍速、往后跳都不卡。只装一个插件，不用装 Python 或其他程序，不收集任何数据。见[播放加速](#播放加速只装一个插件)。
- **下载器（bilidl-web + 下载插件）**：把视频存成 mp4，多线程下载、断点续传、字幕和弹幕。只用 Python 标准库写成，带命令行和本地网页界面。见[下载器](#下载器)。

> 仅供个人学习和备份自己有权观看的内容。视频版权归原作者所有，请遵守 B 站用户协议，不要传播下载的内容。本项目和 B 站官方无关。

## 播放加速（只装一个插件）

B 站网页播放器卡顿，原因是 B 站的视频 CDN 对每个请求单独限速，而播放器一次只发一个请求，4K（平均约 2 MB/s）开 2 倍速就跟不上了。插件接管播放器请求视频分段的请求，拆成 1 MB 的小块，同时从多个实测最快的 B 站视频节点并发拉取，并按播放速度提前预读约 90 秒。画面、弹幕、评论、清晰度切换、播放记录都还是 B 站自己的。

<p align="center"><img src="docs/images/popup.png" alt="插件的弹出页：加速开关、低/中/高三档，当前标签页领先播放位置的秒数、速度、视频和音频用的节点、各节点实测速度" width="360"></p>

### 效果

B 站自己的播放器，锁定 4K（2880x2160），同一网络、同一视频，按 1 倍速 → 2 倍速 → 跳到 60% → 3 倍速播放（2026-10-29，作者在日本的网络）：

| 阶段 | 直连（不装插件） | 装了插件（中档） |
|---|---|---|
| 1 倍速 25 秒 | 不卡，缓冲最少只剩 3 秒 | 不卡，缓冲 ≥ 32 秒 |
| 切到 2 倍速 30 秒 | 卡 4 次，共 10.2 秒 | 不卡，缓冲 ≥ 70 秒 |
| 跳到 60% 后 2 倍速 25 秒 | 一直卡住，只播了 1 秒 | 卡 1 次，0.4 秒 |
| 切到 3 倍速 25 秒 | 一直卡住 | 不卡，缓冲 ≥ 69 秒 |

不锁画质时，装了插件后播放器的自动画质会自己升到 4K（直连时停在 360P）。不同网络、不同时间的效果会不一样；网络本来就很快的话，提升不明显。测试方法和更多数据见 [docs/PLAY_EXTENSION.md](docs/PLAY_EXTENSION.md)。

### 安装

正在申请上架 Chrome 应用商店，上架前请这样装：

1. 到 [Releases](https://github.com/Yangxiamao/bilidl/releases/latest) 下载 `extension-play-x.y.z.zip`（注意不是 `bilidl-vX.Y.Z.zip`，那个是下载器）。
2. 解压到一个固定的文件夹，比如 `D:\bilidl-play`。之后不要删除或移动这个文件夹，Chrome 每次启动都从这里加载。
3. Chrome 打开 `chrome://extensions`，打开右上角的「开发者模式」，点「加载已解压的扩展程序」，选刚才解压出来的文件夹（里面直接就是 `manifest.json`）。
4. 刷新已经打开的 B 站视频页。

不要选本仓库里的 `extension-play/` 文件夹，那是源代码，要先运行 `node tools/build_ext.mjs` 构建，构建结果在 `dist/extension-play/`。

**更新**：下载新版 zip，解压覆盖到同一个文件夹，然后在 `chrome://extensions` 点插件上的刷新按钮，再刷新 B 站页面。

**从 bilidl v1.0.x 升级**：以前的播放加速在下载插件里、要靠 bilidl-web 转发，v1.1.0 起改成了这个独立插件，下载插件和 bilidl-web 里的播放加速都去掉了。到 `chrome://extensions` 点一下下载插件的刷新按钮，再按上面装上播放加速插件即可。只看视频的话，不用再开着 bilidl-web。

### 使用

装好后照常在 B 站网页上看视频即可。支持视频页、列表页、番剧页，切换分 P、切换清晰度、连播都会自动接管。

- **工具栏图标上的数字**：播放器缓冲 + 插件预读一共领先播放位置多少秒（取整到 10 秒）。显示「关」时加速已关闭。
- **点图标打开弹出页**：可以开关加速（关闭后和没装一样），看当前速度、用的节点、占的内存，选档位：

| 档位 | 并发 | 预读 | 每个标签页最多占用内存 |
|---|---|---|---|
| 低 | 6 + 3 | 约 60 秒 | 256 MB |
| 中（默认） | 12 + 4 | 约 90 秒 | 512 MB |
| 高 | 24 + 6 | 约 120 秒 | 1 GB |

4K 3 倍速约需 6 MB/s，低档通常就够；档位主要决定预读多远、占多少内存。

### 隐私和权限
- 只申请了 `storage` 一个权限，用来在本机记住开关和档位。没有 host 权限，不读 cookie，不收集、不上传任何数据。
- 只在 www.bilibili.com 的视频页、列表页、番剧页上运行。视频数据只在浏览器和 B 站的视频服务器之间传输。
- 认不出的请求一律原样交给 B 站，插件出任何错都会退回直连，视频照常播放。
- 完整的隐私说明见 [extension-play/store/PRIVACY.md](extension-play/store/PRIVACY.md)。

### 已知限制
- 需要 Chrome 111 及以上。没有在 Edge 等其他浏览器上测过。
- 嵌入在其他网站里的 B 站播放器（`player.bilibili.com`）和直播不加速。
- 每个标签页各自预读，同时开好几个视频页时内存按标签页叠加。
- 后台标签页里浏览器会限制定时器，预读可能变慢。
- 插件不能让看不了的视频变得能看：大会员、付费内容的限制和平时一样。

## 下载器

和播放加速互相独立：只想在网页上看得流畅，装上面的插件就够了；要把视频存到本地，才需要下面这些。下载器由本机运行的 bilidl-web（Python）完成，`chrome-extension/` 里的下载插件只是在视频页上加一个「下载」按钮，把任务交给它。

- **只走 API 和 CDN**：不依赖 www.bilibili.com 主站，主站连不上时也能下载。
- **多线程分段下载**：B 站 CDN 对每个连接单独限速（每个约 1.5 MB/s），所以默认开 16 个线程，并把链接换到更快的 CDN 节点。在作者的网络环境下，速度从约 2 MB/s 提升到约 24 MB/s。
- **断点续传**：中途取消或程序被关掉，下次会接着下。
- **每个分P一个 mp4**：音视频用 ffmpeg 封装在一起，不重新编码。
- **字幕**：可以同时下载 B 站的人工字幕和 AI 字幕，存成和视频同名的 .srt，也可以只下字幕（需要登录）。
- **弹幕**：可以同时下载弹幕，转成和视频同名的 .danmaku.ass，PotPlayer、VLC 打开视频就能看到滚动弹幕（需要装 biliass）。
- **网页界面**：选择清晰度时能看到各档的估算大小，可以勾选分P、选择保存目录，并实时查看进度、速度和剩余时间。

<p align="center"><img src="docs/images/web-ui.png" alt="bilidl 网页界面：解析视频后选择清晰度（显示各档估算大小）、勾选分P、选择保存目录和线程数" width="760"></p>

## 一键启动（不用命令行）

1. 在本页点击绿色的 **Code** 按钮 → **Download ZIP**，然后解压到任意文件夹。
2. 双击里面的 **`一键启动.bat`**。
3. 浏览器会自动打开下载页面：粘贴视频链接 → 解析 → 选择清晰度和保存位置 → 开始下载。

第一次运行时，如果电脑上没有 Python 或 ffmpeg，它会询问是否自动安装（通过 Windows 自带的 winget，按回车表示同意）。使用期间请不要关闭那个黑色窗口，关掉窗口程序就退出了；没下完的部分下次会接着下。

> 双击时如果 Windows 弹出「无法验证发布者」或 SmartScreen 提示，那是因为文件是从网上下载的。点「运行」或「更多信息 → 仍要运行」即可。脚本内容都是公开的，可以先用记事本打开看看。

想要 720P 及以上清晰度，需要先登录，见下面的[登录](#登录720p-及以上需要)一节。

想在 B 站视频页上一键下载，再装上[下载插件](#chrome-插件在-b-站视频页一键下载)。

> 从旧版本更新：解压新的 ZIP 覆盖旧文件后，先关掉正在运行的 bilidl（黑色窗口；设了开机自启的，重启电脑或在任务管理器里结束 `pythonw`），再双击「一键启动.bat」；然后到 `chrome://extensions` 点下载插件上的刷新按钮。v1.1.0 起播放加速改成了独立的插件，见[播放加速](#播放加速只装一个插件)。

## 环境要求

- Windows 10/11（核心下载逻辑跨平台，但启动脚本、选择文件夹和开机自启目前只适配了 Windows）
- Python 3.10 及以上，下载视频和字幕不需要安装任何第三方包
- [ffmpeg](https://ffmpeg.org/)：`winget install Gyan.FFmpeg`。程序会先在 PATH 里找，再找 WinGet 的安装目录。
- 可选：下载弹幕需要 [biliass](https://pypi.org/project/biliass/)（Python 3.11+，GPL-3.0）：`python -m pip install biliass`。不要加 `--user`，见 [docs/DANMAKU.md](docs/DANMAKU.md)。

用「一键启动」时，这几样都会自动检查。

## 命令行用法速览

```powershell
git clone <本仓库地址> bilidl
cd bilidl

# 命令行：先看各清晰度的大小，再下载
python bilidl.py BV1xxxxxxxxx --info
python bilidl.py BV1xxxxxxxxx -q 720 -o D:\Videos

# 网页界面：启动后会自动打开 http://127.0.0.1:8765/
python bilidl_web.py
```

把这个目录加入 PATH 后，可以直接用 `bilidl` 和 `bilidl-web` 两个命令（见 `bilidl.cmd` 和 `bilidl-web.cmd`）。

## 登录（720P 及以上需要）

未登录时最高只能下 480P；登录后可以下 720P/1080P；1080P60 及以上需要大会员。未登录时 B 站也不返回任何字幕（包括 AI 字幕）。

1. 在浏览器里登录 bilibili.com，按 F12 打开开发者工具，进入「应用/Application」→「Cookie」，复制 `SESSDATA` 的值。
2. 用下面任意一种方式保存：
   - 命令行：`python bilidl.py --set-cookie <SESSDATA>`
   - 网页界面：点击右上角的登录状态，粘贴后保存

cookie 只保存在本机的 `sessdata.txt` 里，这个文件已经写进 `.gitignore`。**它等同于你的登录凭证，不要上传或分享。**

## 命令行用法

```
bilidl <链接或BV号> [-q 清晰度] [-p 分P] [-o 目录] [-j 线程数] [--codec avc|hevc|av1]
bilidl <链接或BV号> --sub [auto|all|语言] [--danmaku] [--sub-only]
bilidl <链接或BV号> --info           只显示各清晰度的大小和字幕，不下载
bilidl --set-cookie <SESSDATA>
```

| 参数 | 说明 |
|---|---|
| `-q` | `360` / `480` / `720`（默认）/ `1080` / `1080+` / `1080p60` / `4k` / `best`；所选清晰度不可用时，自动降到最接近的较低清晰度 |
| `-p` | 例如 `1` 或 `1,3-5`；默认下载全部分P（链接里带 `?p=N` 时只下第 N P） |
| `-o` | 保存目录，默认是当前目录。多P视频会在里面新建一个以标题命名的子文件夹 |
| `-j` | 并发线程数，默认 16，最多 32。线程越多越快，但太多容易被 CDN 风控 |
| `--sub` | 同时下载字幕，存成 `<视频名>.<语言>.srt`。`auto`（不写值时的默认）：全部人工字幕，没有人工字幕时用 AI 识别的字幕；`all`：全部，包括 AI 翻译；也可以写语言代码，如 `zh,en`（`zh` 能匹配 `zh-CN`、`zh-Hans` 和 `ai-zh`）或 `ai-zh` |
| `--danmaku` | 同时下载弹幕，存成 `<视频名>.danmaku.ass`，播放器会自动加载。需要 biliass；样式和播放器设置见 [docs/DANMAKU.md](docs/DANMAKU.md) |
| `--sub-only` | 只下载字幕/弹幕，不下视频，不需要 ffmpeg。既没写 `--sub` 也没写 `--danmaku` 时按 `--sub auto` |

支持的输入：BV 号、视频链接、b23.tv 短链。

## 网页界面

```powershell
python bilidl_web.py              # 启动并打开浏览器
python bilidl_web.py --no-browser # 只启动服务
```

- 服务只监听 `127.0.0.1:8765`，其他设备访问不到。
- 一次只下载一个任务，任务内一个分P下完再下下一个，带宽集中在当前分P上。
- 多P任务开始后，点「展开分P」可以单独「跳过」不想要的分P，排队中和正在下载的都可以跳过。跳过正在下载的分P时，已下的部分会保留；点「恢复」会接着下，任务已经结束的话会重新排队，只下这一P。「重试」不会重新下载跳过的分P。
- 「浏览…」按钮会弹出 Windows 原生的选择文件夹对话框（使用 tkinter）。
- 解析后会列出可用的字幕（人工 / AI 识别 / AI 翻译），可以选择是否一起下载字幕和弹幕，或者只下字幕/弹幕。没装 biliass 时，弹幕选项是灰的，旁边会提示怎么安装。
- 上次用的保存目录、清晰度、线程数、字幕和弹幕选项会记在 `config.json` 里；第一次使用时默认保存到用户的「下载」文件夹，清晰度默认 720P。

### Chrome 插件：在 B 站视频页一键下载

这个插件只负责下载，播放加速是另一个插件（见[播放加速](#播放加速只装一个插件)），两个可以同时装。装上 `chrome-extension/` 里的插件后，B 站视频页右下角会多一个「⬇ 下载」按钮：点开会列出各清晰度和预计大小，点一个就开始下载（多P视频下载全部分P），面板里能看到进度。想选分P、换目录或改字幕选项时，点「更多选项」会打开 bilidl 网页，链接已经填好并自动解析。

1. 打开 `chrome://extensions`，打开右上角的「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `chrome-extension` 文件夹。
3. 打开任意 B 站视频页（已经打开的页面要刷新一下）。

注意：
- 下载仍然由 bilidl-web 完成，所以服务要在运行（用「一键启动」，或者设成开机自启，见下一节）。没运行时面板会提示。
- 保存目录、线程数、字幕和弹幕选项沿用网页界面上次的设置；默认选中上次用的清晰度。
- 插件会读取 Chrome 里 bilibili.com 的 `SESSDATA` cookie，和 bilidl 保存的不一样时自动更新 `sessdata.txt`，以后不用再按 F12 手动复制。Chrome 里没登录时不会改动 bilidl 的 cookie。
- 更新 bilidl 后如果插件文件有变化，到 `chrome://extensions` 点插件上的刷新按钮，再刷新 B 站页面。

### 开机自动在后台运行

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1          # 安装
powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove  # 取消
```

安装后会在「启动」文件夹里创建一个快捷方式，开机时用 `pythonw` 在后台运行服务（没有窗口），日志写到 `bilidl-web.log`。之后把 http://127.0.0.1:8765/ 存成浏览器书签，打开就能用。

### 安全设计

浏览器里的任何网页都能向 `127.0.0.1` 发请求，所以本地接口做了这些防护：

- 每次启动随机生成一个 token，只嵌在本服务返回的页面里。所有 `/api/*` 请求都必须带上 `X-Token` 请求头，这些接口也不返回任何 CORS 头。
- Chrome 插件通过 `/api/token` 取 token：没有 CORS 头，普通网页读不到响应；带了 `Origin` 头但不是 `chrome-extension://` 的请求直接拒绝。
- 校验 `Host` 请求头，防止 DNS rebinding 攻击读取页面里的 token。
- 「打开文件夹」接口只能打开任务的保存目录，或用户自己选过的目录。
- 不记录请求内容，cookie 不会出现在日志或接口返回里。

## 下载是怎么提速的

详细的测量数据见 [docs/SPEEDUP.md](docs/SPEEDUP.md)。简单来说：

1. **CDN 对每个连接单独限速**，总速度随并发线程数近似线性增长。所以按 1 MB 分段，用 Range 请求多线程并发下载。
2. **upos 链接的签名在 query 参数里**，换个域名照样有效。所以把链接的域名换成实测更快的节点（`FAST_HOSTS`，目前是 `mirror08ct` / `mirrorhwb` / `mirrorhw` / `mirroralib` / `mirroraliov`），API 返回的原始链接放在最后兜底。节点会下线、快慢也常变；播放加速插件是按实测速度动态挑节点的，见 [docs/PLAY_EXTENSION.md](docs/PLAY_EXTENSION.md)。
3. **节点健康度**：
   - 下载前同时向所有节点请求文件大小，没有及时答复的节点先降权；
   - 下载中某个节点连续失败 3 次，就冷却 60 秒。
4. **签名过期**：遇到 403/404 时重新请求 playurl 刷新链接，10 秒内只刷新一次，避免触发 412 风控。

## 文件说明

| 文件 | 说明 |
|---|---|
| `bilidl.py` | 核心模块和命令行入口，可以作为模块 import |
| `bilidl_web.py` | 本地网页服务（标准库 `ThreadingHTTPServer`） |
| `bilidl_web.html` | 网页前端，单文件，没有外部依赖，支持浅色/深色模式 |
| `bilidl.cmd` / `bilidl-web.cmd` | Windows 命令行启动器 |
| `一键启动.bat` / `launch.ps1` | 双击启动：检查并可自动安装 Python 和 ffmpeg，然后启动网页界面 |
| `install-autostart.ps1` | 安装或取消开机自启 |
| `chrome-extension/` | 下载插件：在 B 站视频页加「下载」按钮，交给本地服务下载 |
| `extension-play/` | 播放加速插件的源代码（`src/` 里是缓存调度和 XHR 接管），`store/` 里是图标源文件和上架 Chrome 应用商店的材料 |
| `shared/` | 两个插件共用的代码（目前是 CDN 节点列表和挑节点），打包时复制进插件 |
| `tools/build_ext.mjs` | 构建播放加速插件，输出到 `dist/extension-play/`，`--zip` 时另外打包 zip |
| `tools/make_icons.mjs` | 用无头 Chrome 把 `extension-play/store/` 里的 SVG、HTML 渲染成图标和商店图片 |
| `docs/DEVNOTES.md` | 开发笔记：踩过的坑、核心 API、网页界面设计 |
| `docs/SPEEDUP.md` | 提速方案和测量数据 |
| `docs/PLAY_EXTENSION.md` | 播放加速插件：设计、三档配置和实测数据 |
| `docs/EXTENSION_ONLY.md` | 为什么只靠插件就能加速：CDN 按请求限速的实测 |
| `docs/PLAYBACK.md` | 旧的播放加速方案（插件转发到 bilidl-web，v1.1.0 起删除）的记录，节点实测和播放器取数方式仍可参考 |
| `docs/SUBTITLES.md` | 字幕接口的实测情况，以及 B 站不提供字幕时的替代方案 |
| `docs/DANMAKU.md` | 弹幕的数据源、转 ASS 的样式参数、各播放器怎么显示 |
| `tests/` | 手动验收脚本（会真实访问 B 站），见 [tests/README.md](tests/README.md) |

## 已知限制

- B 站的风控策略会变：`/x/web-interface/view` 接口经常返回 412，这时会改用 `pagelist` 接口获取分P列表，再从主站网页取标题；主站也连不上时，就用 BV 号当标题。
- 下载只支持普通视频（BV 号），不支持番剧、课程和直播（播放加速支持番剧页）。
- 字幕只能下载 B 站已有的（人工或 AI 字幕）。约三成视频连 AI 字幕都没有，替代方案见 [docs/SUBTITLES.md](docs/SUBTITLES.md)。
- 弹幕只有接口公开下发的部分（和网页、客户端看到的一样），没有历史弹幕；ASS 弹幕播放时不能调密度和透明度。
- CDN 节点的快慢和网络环境有关，`FAST_HOSTS` 是在作者的网络下测出来的，而且节点会下线（2026-10 时 `mirror08c` 已经解析不到）。下载按列表顺序用节点；播放加速插件按实测速度排序。

## License

[MIT](LICENSE)。可选依赖 biliass 是 GPL-3.0，没有打包在本仓库里。
