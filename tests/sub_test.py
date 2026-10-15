import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # 仓库根目录
import bilidl
root = sys.argv[1]

print("=== 1. 选择规则和 SRT 格式（离线）===")
subs = [{"lan": l, "ai": l.startswith("ai-"), "translated": l in ("ai-en", "ai-ja")}
        for l in ("zh-CN", "en-US", "ai-zh", "ai-en", "ai-ja")]
for spec, want in (("auto", ["zh-CN", "en-US"]), ("all", [s["lan"] for s in subs]), ("zh", ["zh-CN", "ai-zh"]),
                   ("ai-zh", ["ai-zh"]), ("en", ["en-US", "ai-en"])):
    got = [s["lan"] for s in bilidl.select_subtitles(subs, spec)]
    print(spec, "OK" if got == want else f"错误：{got}")
got = [s["lan"] for s in bilidl.select_subtitles([s for s in subs if s["ai"]], "auto")]
print("auto 只有 AI 字幕时", "OK" if got == ["ai-zh"] else f"错误：{got}")
srt = bilidl.to_srt([{"from": 3661.5, "to": 3662.0004, "content": " a "}, {"from": 0, "to": 1, "content": ""}])
print("to_srt", "OK" if srt == "1\n01:01:01,500 --> 01:01:02,000\na\n" else repr(srt))

print("=== 2. 字幕列表（需要登录）：多次请求结果一致 ===")
api = bilidl.Api()
BV, CID, DUR = "BV1GJ411x7h7", 137649199, 213  # 有 12 条人工字幕
seen = {tuple(s["lan"] for s in bilidl.list_subtitles(api, BV, CID)) for _ in range(5)}
print("一致" if len(seen) == 1 else "不一致", next(iter(seen)))

print("=== 3. 下载、跳过已存在、未登录 ===")
print(bilidl.download_subtitles(api, BV, CID, root, "t", "zh-Hans,en", DUR))
print(bilidl.download_subtitles(api, BV, CID, root, "t", "zh-Hans,en", DUR))  # 第二次不重新下载
api.sess = ""
print("未登录:", bilidl.download_subtitles(api, BV, CID, root, "guest", "auto", DUR))
