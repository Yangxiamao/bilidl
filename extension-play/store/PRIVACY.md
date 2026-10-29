# bilidl 播放加速：隐私说明

最后更新：2026-10-29

**这个插件不收集、不保存、不发送任何个人数据或使用数据。** 没有统计、没有广告、没有账号，也不连接除 B 站以外的任何服务器。

## 插件做什么
在 www.bilibili.com 的视频页、列表页、番剧页上，接管 B 站网页播放器请求视频分段的请求，改成从 B 站的视频 CDN（`upos-*.bilivideo.com`、`upos-*.akamaized.net`）并发拉取、提前预读，再交还给播放器。视频数据只在你的浏览器和 B 站的 CDN 之间传输，不经过任何第三方。

## 在哪里运行
只在下面这些页面上运行（包括 `/zh-Hans/` 这类语言前缀）：
- `https://www.bilibili.com/video/*`
- `https://www.bilibili.com/list/*`
- `https://www.bilibili.com/bangumi/play/*`

其他网站、B 站的其他页面都不会运行。

## 权限
只申请了一个权限：**`storage`**，用来在你的电脑上记住两项设置：加速开关和档位（低/中/高）。这两项设置只存在本机的 Chrome 里，不会上传。

插件**没有**申请 cookie、浏览记录、标签页、下载、网络请求拦截等权限，读不到你的 B 站账号信息，也看不到你在其他网站上的任何内容。

## 内存里的数据
为了预读，插件会在当前标签页的内存里暂存视频数据（每个标签页有上限，可以在弹出页里看到）。关掉标签页、关闭加速、或闲置 10 分钟后就会释放，不写入硬盘。

## 联系
问题和反馈请到 <https://github.com/Yangxiamao/bilidl/issues>。源代码公开在 <https://github.com/Yangxiamao/bilidl>（`extension-play/` 和 `shared/` 目录）。

---

## Privacy policy (English)

**This extension does not collect, store, or transmit any personal or usage data.** There is no analytics, no ads, no account, and it talks to no server other than Bilibili's own.

- **What it does:** on www.bilibili.com video, list and bangumi pages, it takes over the web player's requests for video segments and fetches them from Bilibili's video CDN (`upos-*.bilivideo.com`, `upos-*.akamaized.net`) with several parallel requests plus read-ahead, then hands the data back to the player. Video data only travels between your browser and Bilibili's CDN.
- **Where it runs:** only `https://www.bilibili.com/video/*`, `/list/*` and `/bangumi/play/*` (including language-prefixed paths such as `/zh-Hans/`).
- **Permissions:** only `storage`, used to remember two settings locally (on/off and the low/mid/high profile). No cookies, history, tabs, downloads or webRequest permissions.
- **Memory:** buffered video data is kept in the tab's memory only (capped per tab) and is released when the tab closes, acceleration is turned off, or after 10 minutes idle. Nothing is written to disk.
- **Contact:** <https://github.com/Yangxiamao/bilidl/issues>. Source code: <https://github.com/Yangxiamao/bilidl>.
