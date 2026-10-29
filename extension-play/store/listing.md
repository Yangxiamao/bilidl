# Chrome 应用商店的商品详情（复制粘贴用）

开发者后台每个字段填什么。带「审核用」的字段只给审核员看，中英文都写上，审核员读英文更快。

## 商品详情（Store listing）

**名称**（最多 75 个字符）
```
bilidl 播放加速
```

**简短说明**（Summary，最多 132 个字符）
```
B 站网页播放器多路并发预读：4K、倍速、跳转都不卡。只装一个插件，不用装其他程序，不收集任何数据。
```

**详细说明**（Description）
```
在 B 站网页上看 4K、开倍速、往后跳的时候总是转圈？原因是 B 站的视频 CDN 对每个请求单独限速，而网页播放器一次只发一个请求，高码率、倍速时就跟不上。

这个插件接管播放器请求视频分段的请求，把它拆成 1 MB 的小块，同时从多个实测最快的 B 站视频节点并发拉取，并提前预读约 90 秒，倍速时预读量自动跟着变大。画面、弹幕、评论、清晰度切换、播放记录都还是 B 站自己的，和平时用法完全一样。

【效果】作者实测（4K 视频，B 站自己的播放器，同一网络）：
· 切到 2 倍速：直连卡 4 次共 10.2 秒 → 装了插件不卡
· 跳到 60% 后 2 倍速：直连一直卡住 → 装了插件只卡 1 次 0.4 秒
· 切到 3 倍速：直连一直卡住 → 装了插件不卡，缓冲领先 1 分钟以上
不同网络、不同时间效果会不一样；网络本来就很快的话，提升不明显。

【用法】
装好后打开（或刷新）B 站视频页，照常看就行。点工具栏上的图标可以：
· 开关加速（关闭后和没装一样）
· 选档位：低 / 中（默认）/ 高，档位越高预读越多、占的内存越多
· 看当前状态：领先播放位置多少秒、速度、用的节点
图标上的数字是「播放器缓冲 + 插件预读」领先的秒数。

【支持的页面】www.bilibili.com 的视频页、列表页、番剧页，包括切换分 P、切换清晰度、自动连播。

【隐私】
· 不收集、不上传任何数据，没有统计和广告
· 只在 B 站的视频、列表、番剧页上运行
· 只申请了 storage 一个权限，用来在本机记住开关和档位
· 视频数据只在你的浏览器和 B 站的视频服务器之间传输

【说明】
· 这是个人开发的开源插件，不是 B 站官方插件。
· 只加速 B 站网页上的播放，不提供下载功能，不能绕过会员或付费限制，看不了的视频装了插件也看不了。
· 源代码：https://github.com/Yangxiamao/bilidl
· 问题反馈：https://github.com/Yangxiamao/bilidl/issues
```

**类别**：选「工具」（Tools）；后台的类别列表有变化时选最接近「视频 / 工具」的一项。

**语言**：中文（简体）

**图片**（见 [CHECKLIST.md](CHECKLIST.md)）
- 商店图标 128x128：`extension-play/icons/128.png`
- 截图（1280x800）：你自己截的 1~2 张 + `screenshot-compare-1280x800.jpg`
- 小宣传图 440x280：`promo-440x280.jpg`

**官方网址 / 支持网址**：`https://github.com/Yangxiamao/bilidl`

## 隐私权（Privacy practices）

**单一用途说明**（Single purpose，审核用）
```
加速 www.bilibili.com 网页播放器的视频加载：把播放器的视频分段请求拆成多个并发请求、提前预读，减少 4K、倍速、跳转时的卡顿。

Speeds up video loading in the www.bilibili.com web player: it splits the player's video segment requests into several parallel requests to Bilibili's CDN and reads ahead, so 4K, fast playback speeds and seeking do not stall.
```

**storage 权限的理由**（审核用）
```
只用来在本机保存两项用户设置：加速开关、档位（低/中/高）。不保存任何个人数据或浏览数据。

Used only to store two user settings locally: whether acceleration is on, and the selected profile (low/mid/high). No personal or browsing data is stored.
```

**主机权限的理由**（审核用。插件没有 host_permissions，但内容脚本的 matches 在后台里也算在这一项）
```
内容脚本只在 www.bilibili.com 的视频页（/video/）、列表页（/list/）和番剧页（/bangumi/play/）上运行：需要在播放器脚本之前接管它请求视频分段的 XMLHttpRequest，再从 B 站自己的视频 CDN 并发拉取。不在其他任何网站或页面上运行，不读取页面内容或用户数据。

The content scripts run only on www.bilibili.com video (/video/), list (/list/) and bangumi (/bangumi/play/) pages. They must run before the player's scripts to take over its XMLHttpRequests for video segments and fetch the same segments from Bilibili's own video CDN in parallel. They do not run on any other site or page and do not read page content or user data.
```

**是否使用远程代码**：选「否，我没有使用远程代码」。
```
所有代码都打包在插件里，不加载、不执行任何远程脚本。网络请求只用于下载 B 站视频 CDN 上的视频分段数据（ArrayBuffer），不会被当作代码执行。

All code is bundled in the extension; no remote scripts are loaded or executed. Network requests only fetch video segment bytes from Bilibili's CDN, which are never executed as code.
```

**数据使用**：所有收集类型都**不勾选**（个人身份信息、健康、财务、身份验证、个人通讯、位置、网络记录、用户活动、网站内容都不收集），然后勾选下面三项声明：
- 我不会出于获批用途之外的用途向第三方出售或传输用户数据
- 我不会为实现与商品单一用途无关的目的而使用或转移用户数据
- 我不会为确定信用度或实现贷款而使用或转移用户数据

**隐私权政策网址**：合并进 main 以后填
```
https://github.com/Yangxiamao/bilidl/blob/main/extension-play/store/PRIVACY.md
```

## 分发（Distribution）
- 公开范围：公开（Public）
- 地区：所有地区
- 价格：免费
