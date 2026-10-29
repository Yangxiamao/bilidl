# 只装插件就能下载（extension-dl/）：可行性验证

## 结论
**可行，最小可用版本已经能用。** 下载插件只靠 Chrome 自己的能力完成整个流程：取 playurl → 并发下载 → 合成 mp4 → 存到硬盘。不需要 Python，不需要 ffmpeg，也不需要本地服务。

| 要验证的 | 结果 |
|---|---|
| 1. 纯 JS 合成 mp4 | ✅ 不用 ffmpeg.wasm，约 500 行（`src/mux.js`）。和 `ffmpeg -c copy` 的输出比较：每个流的数据哈希、每个 packet 的 pts/dts/时长/大小/关键帧、流的时长和帧数**全部一致**（avc / hevc / av1 + AAC / HE-AAC），完整解码无报错，Chrome 和 ffmpeg 里都能拖动。下载时就按最终布局写，**不需要中间文件，也不需要最后再合并一遍**，收尾（生成样本表）只要几十毫秒 |
| 2. 写盘 | ✅ 先写进插件自己的存储（OPFS，原地写、随机写约 950 MB/s），下完再一次性复制到用户选的目录（File System Access）或下载目录（`chrome.downloads`）。内存里只有正在下载的分段。直接往用户目录边下边写**不可行**，原因见下文 |
| 3. 断点续传 | ✅ 进度位图存在 IndexedDB，数据在 OPFS 里。下到 40% 时直接杀掉 Chrome 进程，重启后插件自己接着下，最终文件和参考一致 |
| 4. 速度 | ✅ 不比 Python 版慢：同一个 4K 流，16 并发时插件 36~38 MB/s、Python 版 13~21 MB/s；32 并发时插件 48 MB/s、Python 版 41 MB/s。下载放在 offscreen document 的 Worker 里，**关掉所有标签页也照常下载**，浏览器关掉后重开会接着下 |
| 5. 字幕 SRT、弹幕 ASS | ⏸ 只做了评估：SRT 约半天；弹幕要自己写排版（biliass 是 GPL-3.0，本仓库是 MIT，不能照搬），约 1~2 天 |
| 6. 权限 / 上架 | 需要 6 个权限 + 3 个 host 权限（见下文），都是窄范围的。上架有被拒的风险（下载受版权保护内容的条款），被拒就继续走 GitHub Release |

## 怎么装（开发版）
1. `node tools/build_ext.mjs`，生成 `dist/extension-dl/`（`--zip` 时另外打一个 zip）。
2. `chrome://extensions` →「开发者模式」→「加载已解压的扩展程序」，选 `dist/extension-dl`。
3. 打开 B 站视频页，点插件图标：选分P（多P视频可以选「全部」）、清晰度、编码，点「下载」。登录状态直接用浏览器里的，不用另外设置 SESSDATA。
4. 默认存到浏览器的下载目录。想存到别的文件夹：弹出页底部「更改」，在设置页里选一个目录。

和旧的 `chrome-extension/`（交给本地 bilidl 下载）、[bilifast](https://github.com/Yangxiamao/bilifast)（播放加速）互不影响，可以同时装。

## 设计

```
弹出页 / 设置页 ──消息──▶ background.js（service worker）──▶ offscreen.html ──▶ src/worker.js（专用 Worker）
                                  │  DNR：给本插件的请求加 Referer        │  blob URL                │ playurl、并发 fetch、
                                  │  chrome.downloads 存到下载目录 ◀──────┘                           │ 写 OPFS、进度存 IndexedDB、
                                  │  角标                                                             │ 收尾、复制到用户目录
```

| 文件 | 作用 |
|---|---|
| `src/mux.js` | 合成 mp4：解析 m4s 开头的 init + sidx，算输出布局，把每段下载到的数据放到输出位置，下完后生成 moov。不碰文件，读写由调用方传入 |
| `src/download.js` | 下载引擎：1 MB 分段、并发、挑节点（`shared/hosts.js`，和播放加速一样按实测速度加权）、卡住或太慢就换节点、链接过期时刷新、最后几段向另一个节点对冲。fetch 和写文件从外面传入，可以离线测 |
| `src/worker.js` | 任务队列、OPFS 文件、进度保存、导出 |
| `src/api.js`、`src/md5.js` | B 站接口（bilidl.py 的 `Api` / `video_meta` / `playurl` / `pick_streams` 的 JS 版），WBI 签名要用 MD5，WebCrypto 没有，自己实现了一个 |
| `src/db.js` | IndexedDB：任务和设置（包括保存目录的句柄） |
| `offscreen.js` | Worker 的宿主；Worker 里没有 `chrome.runtime`，消息由它转发；给 OPFS 文件建 blob URL 交给后台保存 |
| `background.js` | DNR 规则、建 offscreen document（浏览器启动时也建，好接着下）、`chrome.downloads`、角标 |
| `popup.*` | 弹出页；`?page=settings` 是设置页（选目录要在普通标签页里，弹出页一失去焦点就会关掉） |

### 1. 合成 mp4
B 站的 m4s 是 SegmentBase 形式的 fMP4：`ftyp`、`moov`（样本表是空的）、`sidx`（每个分片的大小和时长），然后是一串 `moof + mdat`（每个分片约 5 秒）。playurl 的 `segment_base.index_range` 给出 sidx 的位置，**先取开头这一小段（约 1~12 KB），就能在下载前算出整个输出文件的布局**：
- 输出是 `ftyp`、预留给 `moov` 的空间、按时间交错的分片（视频和音频各 5 秒一个，交替排列）。每个分片原样搬过去，下载到的任何一段都知道它在输出文件里的位置，直接写进去。
- 每个分片开头的 `moof` 只把类型改成 `free`（4 个字节），内容留在文件里。下完以后扫一遍这些 `free`，从 `tfhd`/`tfdt`/`trun` 里取出每个样本的时长、大小、关键帧、CTS 偏移，生成普通 mp4 的 `stts`/`ctts`/`stss`/`stsc`/`stsz`/`stco`(`co64`)，写进前面预留的位置（相当于 `-movflags faststart`，但不用搬动整个文件）。预留大小按「时长 × 帧率 × 1.25」估上界，4K 72 分钟约 13 MB；万一不够就把 moov 写在末尾（和 ffmpeg 默认一样）。
- 内存：收尾时每个样本几个数字，72 分钟 4K60 约 45 万个样本，几十 MB 以内。

和 ffmpeg 对齐时发现的几个细节（都已处理）：
- hevc 的 m4s 的 `elst` 有两段：先是 50 ms 的空编辑（media_time = −1），再从 media_time 800 开始。ffmpeg 丢掉空编辑、保留 800，否则起始时间会变成 0.05 秒。
- 音频最后一帧通常只有一部分有效：ffmpeg 按 sidx 的总时长把最后一个样本截短（1024 → 1014）。
- 影片时间刻度取各轨道的最小公倍数（16000 和 44100 → 7056000），用 1000 的话音频时长会差 0.4 ms。
- 音频的 `sgpd`/`sbgp`（AAC 的 roll 分组）要从 moof 里搬到 moov。

**普通 mp4 还是 fMP4**：两种都实现了（设置里的 `format`，默认 `mp4`）。fMP4 不用收尾，但 moov 里没有帧数，也没有结尾裁剪信息，最后一个音频包会多出约 10 个样本。有些播放器在 fMP4 里拖动要先扫描整个文件。普通 mp4 和 Python 版的输出完全一样，所以默认用它。两者在 Chrome 和 ffmpeg 里拖动都正常（`tests/dl_seek_test.mjs`）。

### 2. 写盘：为什么先写 OPFS
实测（`createWritable` 是往用户选的目录写文件的唯一方法）：

| | 结果 |
|---|---|
| `createWritable()` 写 64 MB，没 `close()` 就杀掉 Chrome | 重启后文件是 **0 字节**，旁边留下一个 `.crswap`。它写的是临时文件，`close()` 时才替换原文件 |
| 1 GB 的文件 `createWritable({ keepExistingData: true })` | 打开要 **6 秒**（先把整个文件复制到 `.crswap`），8.5 GB 估计约 50 秒，每次续传都要来一次 |
| OPFS `createSyncAccessHandle()`（只能在 Worker 里用），1 GB 随机顺序写 | 约 950 MB/s；`flush()` 之后杀掉 Chrome，64 MB 全部还在 |
| OPFS 文件的 blob URL 交给 `chrome.downloads.download` | 1 GB 用 3 秒存进下载目录 |
| 插件 service worker 返回流式 Response，交给 `chrome.downloads` | 失败（`NETWORK_FAILED`），不能这样边生成边存 |
| 存储配额（`unlimitedStorage`） | 187 GB（这台机器 C 盘剩 160 GB，配额按磁盘算） |

所以：**下载时写 OPFS（续传靠它），下完再复制出去**。代价是下完复制的那一刻要占两份磁盘空间，以及多一次本地复制（几秒到几十秒）。开始前检查配额，不够就提示。

保存目录：设置页里 `showDirectoryPicker` 选一次，句柄存进 IndexedDB，Worker 直接用它写。授权能不能记住，在有界面的 Chrome 里请人配合测了（`tests/dl_ext_test.mjs fsa`）：
- 选目录后，页面和后台 Worker 里都是 `granted`，文件写进了选的目录。
- **正常关闭再打开 Chrome 后变成 `prompt`**（要重新授权），这时只存得到下载目录（插件会自动改存下载目录，并在弹出页提示）。
- 在设置页点「重新授权」后，再关掉、打开一次，仍然是 `granted`：Chrome 的「持久授权」对插件也生效，只是第一次选目录时不会直接给持久授权，要在第一次重启后重新授权一次：这时 Chrome 的提示里有「始终允许」，选它以后，重启也不会再失效。所以弹出页在授权失效时会提示「需要重新授权」，设置页有「重新授权」按钮。

没有选目录、或者授权失效时，用 `chrome.downloads` 存到下载目录：后台 service worker 里没有 `URL.createObjectURL`，所以由 offscreen document 建 blob URL。多P视频用 `标题/P1 分P名.mp4` 的相对路径，`conflictAction: "uniquify"` 不覆盖同名文件。

### 3. 断点续传
- 进度：每条轨道一个位图（每个 1 MB 分段 1 个字节），和任务信息一起存在 IndexedDB。每 2 秒做一次：先复制位图，再 `flush()` 文件，然后保存复制出来的位图，保证记成「已完成」的分段一定已经落盘。
- 重新开始时（暂停后继续、浏览器重启后自动继续）先重新请求 playurl，取到新的签名链接，再取一次文件头，和保存的逐字节比较：不一样（B 站重新转码了）就从头下，一样就跳过已完成的分段。
- 浏览器启动时（`runtime.onStartup`）后台会建 offscreen document，Worker 把「下载中 / 排队中」的任务接着下。**和文件句柄的配合**：OPFS 不需要授权，所以续传不受目录授权影响；只有最后复制到用户目录时才需要授权，没有授权就存到下载目录。

### 4. 在哪里跑
| 上下文 | 能否下载 | 关掉标签页后 | 结论 |
|---|---|---|---|
| bilibili.com 页面里 | 能（CORS 本来就放行，不需要 host 权限） | 停止 | 不用 |
| service worker | 能 | 30 秒没有事件就会被回收，几个小时的下载不可靠；也没有 SyncAccessHandle | 只做调度 |
| **offscreen document + 专用 Worker** | 能（需要 host 权限） | **继续**；只要有任务就一直在，没有任务 60 秒后自己关掉 | 采用 |

从插件发出请求时要注意：
- 登录 cookie：`fetch(api, { credentials: "include" })` 会带上浏览器里的 SESSDATA（插件有 `api.bilibili.com` 的 host 权限），拿得到 4K 和大会员清晰度。
- **bilivideo 的节点不带 `Referer: https://www.bilibili.com/` 就返回 403**（akamai 不检查），Origin 是什么无所谓，CORS 会原样回显。fetch 不能把 Referer 设成别的网站，所以用 DNR 的 `modifyHeaders` 加上，`initiatorDomains` 限定为插件自己的 ID，不影响网页发出的请求。只需要 `declarativeNetRequestWithHostAccess`（不会多一条权限警告）。

## 实测
2026-10-29，作者的网络（日本），登录账号（大会员），Chrome 156，无头模式，静音。

### 合成：`node tests/dl_mux_test.mjs <样本目录> --both`
样本：BV1Q24y1j7YT P1（约 3 分钟）的 4K avc（332 MB）、4K hevc（133 MB）、1080P av1 + HE-AAC（19 MB），用 bilidl.py 下载、不合并，参考文件是 `ffmpeg -c copy` 的输出。

| | 普通 mp4 | fMP4 |
|---|---|---|
| 每个流的 packet 数据哈希（`ffmpeg -f streamhash`） | 一致 | 一致 |
| 每个 packet 的 pts / dts / 时长 / 大小 / 关键帧（1~2 万个） | 一致 | 一致（只差最后一个音频包的裁剪信息） |
| 流的编码、分辨率、起始时间、时长、帧数 | 一致 | 一致（没有帧数） |
| 完整解码 | 无报错 | 无报错 |
| 收尾用时 | 11~43 ms | 3~7 ms |
| moov / 预留 | 74~240 KB / 534~660 KB | – |

拖动（`tests/dl_seek_test.mjs`）：Chrome `<video>` 跳到 10% / 50% / 90% / 99% 都能在 0.1~1.2 秒内 `seeked` 并出画面，和 ffmpeg 的参考文件一样；`ffmpeg -ss` 在同样位置都能解出一帧。

### 下载引擎（离线）：`node tests/dl_engine_test.mjs <样本目录> avc4k`
用本地样本假装 CDN：fast 正常、slow 慢、stall 给了响应头就不再给数据、flaky 一半请求出错，第 150 个请求起旧签名返回 403。下到 40% 时取消再续传：续传只拉剩下的 190 段，其中 fast 拿了 175 段、slow 15 段、其余两个 0 段；签名过期后两条轨道各刷新了一次链接；最终和参考的数据哈希一致。

### 端到端：`node tests/dl_ext_test.mjs e2e|resume`
- BV1Q24y1j7YT P1 4K avc（332 MB）：18 秒下完，平均 19 MB/s；存进下载目录的 `标题/P1 分P名.mp4`，和参考的数据哈希一致；OPFS 里的临时文件已删掉。
- 续传：下到 41% 时杀掉 Chrome 进程（杀掉前 136 MB，最后一次存的进度是 126 MB），重启后插件自动从 126 MB 接着下，最终文件和参考一致。

### 速度：`tests/speed_bench.py` 和 `node tests/dl_ext_test.mjs speed`
BV1bE41127s6 P1 的 4K avc 视频流（8.5 GB），各下 30 秒，交替进行，MB = 10⁶ 字节：

| | Python 版 | 插件 |
|---|---|---|
| 16 并发，第 1 轮 | 20.6 MB/s | 36.4 MB/s |
| 16 并发，第 2 轮 | 13.0 MB/s | 38.1 MB/s |
| 32 并发 | 40.6 MB/s | 48.2 MB/s |

Python 版按固定顺序用节点，这几轮都只用了 08ct；插件按实测速度把请求分给几个快节点。同一时间在扩展页面里和在 bilibili.com 页面里并发 fetch，速度一样（8.5 vs 8.3 MB/s，那一轮各节点都慢），都是一条 h2 连接。

### 完整的 8.5 GB：插件和 Python 版各下一次
BV1bE41127s6 P1，4K avc 2880x2160，72 分钟，视频 8510 MB + 音频 172 MB，32 并发，先后各下一次：

| | Python 版（`bilidl.py -q 4k -j 32`） | 插件（`tests/dl_ext_test.mjs e2e --workers 32 --mem`） |
|---|---|---|
| 下载 | 287 秒（视频 263 秒 + 音频 24 秒，一个流下完才下另一个） | **158 秒**（两个流一起下，平均 55 MB/s） |
| 合并 / 收尾 | ffmpeg 约 0~10 秒 | 生成 moov 1 秒 |
| 存到目标位置 | –（直接写在输出目录） | 40 秒（OPFS → 下载目录，`chrome.downloads` 复制） |
| 总用时 | 302 秒 | **199 秒** |
| 输出 | 8,687,813,880 字节 | 8,696,948,908 字节（多 9 MB：预留给 moov 的空间没用完的部分，和改名成 free 的 moof） |
| 数据 | – | 每个流的 packet 数据哈希和 Python 版**一致**（258,325 + 202,022 个 packet） |
| moov | 文件末尾 | 文件开头：5.2 MB，预留了 14.8 MB（上界估得偏宽，以后可以收紧） |
| 拖动 | Chrome / ffmpeg 正常 | Chrome / ffmpeg 正常，跳到任意位置 0.3~1 秒 |
| 内存 | – | Chrome 所有进程的工作集 720~920 MB，空闲时（插件已加载、开着插件页面）是 706~791 MB；整个下载过程不随文件变大 |

插件快，主要是因为视频和音频一起下、并且按速度把请求分到几个快节点上；Python 版那一轮从头到尾只用了 08ct。

## 字幕和弹幕：工作量评估（还没做）
- **字幕转 SRT**：`list_subtitles` / `select_subtitles` / `to_srt` 照着 bilidl.py 改成 JS 约 100 行；字幕文件在 `aisubtitle.hdslb.com`、`i0.hdslb.com` 上，要加 `*.hdslb.com` 的 host 权限；小文件的导出（写目录或 `chrome.downloads`）可以复用视频的路子。约半天。
- **弹幕转 ASS**：protobuf（`DmSegMobileReply`）手写解码约 60 行。难的是排版：滚动弹幕分行、避免重叠、按字符宽度估算文字长度、顶部和底部弹幕的停留，要接近 biliass 的效果约 300 行，加上调样式，估计 1~2 天。**biliass 和它的上游 Danmaku2ASS 都是 GPL-3.0**，本仓库是 MIT，不能把代码移植进插件，只能参照效果自己写。

## 权限和上架
| 权限 | 用途 |
|---|---|
| `offscreen` | 在后台下载（关掉标签页也继续） |
| `unlimitedStorage` | OPFS 里放得下 8 GB 的文件 |
| `downloads` | 存到下载目录（没选保存目录、或授权失效时） |
| `declarativeNetRequestWithHostAccess` | 给插件自己的 CDN 请求加 Referer |
| `storage` | `chrome.storage.session`：下载目录的保存和任务的对应关系 |
| `activeTab` | 弹出页读当前标签页的网址（只在点图标时） |
| host：`api.bilibili.com`、`*.bilivideo.com`、`*.akamaized.net` | 接口（带登录 cookie）和 CDN |

没有内容脚本、没有远程代码。以后加字幕再加 `*.hdslb.com`。

**上架风险**：Chrome Web Store 的政策写着不得「鼓励、协助或使未经授权的访问、下载、播放受版权保护的内容」成为可能，视频下载器也不会被推荐（[开发者计划政策](https://developer.chrome.com/docs/webstore/program-policies/policies)）。YouTube 下载器基本都会被拒，B 站没有被点名，但审核员同样可能按这一条拒绝。降低风险的写法：说明只下载用户自己能观看的内容、不绕过付费和登录限制（插件确实不绕过：拿不到的清晰度就是拿不到）。按原定方案，播放加速先单独上架，下载插件先试着提交，被拒就继续走 GitHub Release。

## 没做 / 已知问题
- 番剧（`/bangumi/play/ep…`）要用 pgc 的 playurl 接口，没做；现在只认 BV 号。
- 没测：FLAC、杜比音频、HDR、杜比视界、8K 的样本（`stsd` 原样复制，按理不受编码影响，要找样本测）；多P选「全部」；在真实弹出页里手动操作（测试是把 popup.html 当普通标签页打开）；Chrome 设置了「下载前询问保存位置」时 `saveAs: false` 是否还会弹框。
- 下完后存到下载目录这一步，进度在 Chrome 自己的下载列表里，插件里只显示「正在保存」。
- 复制出去的瞬间要两份磁盘空间（OPFS 一份、目标一份），复制完马上删掉 OPFS 里的。
- 一次只下一个任务，任务内并发（默认 16，设置里可以改 4~32）。
- 播放加速插件（bilifast）的 `HostHealth` 是每个标签页一份，下载插件是每个任务一份，两者不共享测速结果。
