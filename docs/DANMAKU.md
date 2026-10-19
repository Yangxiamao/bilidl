# 弹幕：怎么下、怎么在本地播放器里显示

## 做法

下载弹幕的原始数据，用 [biliass](https://pypi.org/project/biliass/) 转成 ASS 字幕，存成 `<视频名>.danmaku.ass`，放在视频旁边。PotPlayer、VLC、mpv 打开视频时会自动加载它，弹幕就会像网页上那样滚动显示，不用换播放器。

biliass 是 Danmaku2ASS 的 B 站适配版（Rust 实现，yutto 下载器也在用）。它是可选依赖：

- 安装：`python -m pip install biliass`（需要 Python 3.11+）。不要加 `--user`：网页服务和一键启动都用 `python -I` 运行，`-I` 会忽略用户目录里的包。一键启动会询问是否自动安装。
- 没装时，视频和字幕照常下载，只是跳过弹幕，并提示怎么安装。
- biliass 的许可证是 GPL-3.0。bilidl 只在运行时调用它，不打包进仓库，所以 bilidl 本身仍然是 MIT 许可证。

## 数据源（2026-10 实测）

- **接口**：protobuf 分段接口 `x/v2/dm/wbi/web/seg.so?type=1&oid=<cid>&segment_index=<n>`，WBI 签名。签名版失败时退回不签名的 `x/v2/dm/web/seg.so`，两者返回的数据完全一样。
- **分段**：每段 6 分钟，段数是 `ceil(时长 / 360)`。用 4 个线程并发取，各段原样交给 `biliass.convert_to_ass([段1, 段2, ...], input_format="protobuf")`，不需要自己解析 protobuf。
- **为什么不用 XML 接口**：`comment.bilibili.com/<cid>.xml` 和 `x/v1/dm/list.so` 有条数上限，长视频的弹幕会不全。
- **和官方客户端是同一份数据**：B 站 Windows 客户端的离线缓存目录（`%USERPROFILE%\Videos\bilibili\<cid>\`）里的 `dm1`、`dm2`… 就是这个接口的原始返回，逐字节相同。实测一个 2 小时的直播回放，接口和客户端缓存都是 278 条，而页面上显示的弹幕数是 655。差出来的部分接口本来就不下发，例如被「按等级优化弹幕」过滤掉的，所以网页和客户端也看不到。

## 样式

参数在 `bilidl.py` 的 `DM_STAGE` / `DM_STYLE`，目标是接近网页版：

| 参数 | 值 | 说明 |
|---|---|---|
| 舞台 | 1920×1080 | ASS 会按视频实际分辨率缩放 |
| `font_size` | 38 | 约等于网页 720p 播放器里的 25px |
| `text_opacity` | 0.8 | |
| `duration_marquee` | 10 秒 | 滚动弹幕从右到左的时间 |
| `duration_still` | 5 秒 | 顶部、底部弹幕的停留时间 |
| `display_region_ratio` | 0.75 | 只占画面上方 3/4，不挡底部字幕 |
| `reduce_comments` | False | 不丢弃弹幕；太密时 biliass 会叠到下一层 |

改参数后，删掉旧的 `.danmaku.ass` 重新下载即可，不用重新下视频。

## 播放器

- **PotPlayer**：自动加载。和 `.srt` 字幕同时存在时，右键 →「字幕」里可以选主字幕和副字幕，两条一起显示。
- **VLC**：自动加载（默认设置下会加载文件名包含视频名的字幕）。一次只能显示一条字幕轨，要在「字幕 → 子轨道」里切换弹幕和字幕。
- **mpv**：自动加载；`--sub-auto=fuzzy` 时更稳。可以用 `--secondary-sid` 同时显示字幕。

## 已知限制

- 只有接口公开下发的弹幕，没有历史弹幕（按日期查需要登录接口，暂时没做）。
- 高级弹幕、代码弹幕、BAS 弹幕 biliass 不支持，会被跳过。
- ASS 是事先排好版的，播放时不能调弹幕密度、透明度，也不能屏蔽关键词。需要这些功能时，可以用弹弹play 或 mpv 的弹幕插件，它们在播放时实时渲染弹幕。
