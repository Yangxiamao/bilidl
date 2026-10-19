import builtins, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # 仓库根目录
import bilidl
root = sys.argv[1]


def varint(n):
    out = bytearray()
    while True:
        out.append((n & 0x7f) | (0x80 if n > 0x7f else 0))
        n >>= 7
        if not n:
            return bytes(out)


def elem(ms, text, mode=1):
    """手工拼一条 DanmakuElem：progress(2) mode(3) fontsize(4) color(5) content(7)，再包进 DmSegMobileReply.elems(1)"""
    t = text.encode()
    body = b"\x10" + varint(ms) + b"\x18" + varint(mode) + b"\x20" + varint(25) + b"\x28" + varint(0xffffff)
    body += b"\x3a" + varint(len(t)) + t
    return b"\x0a" + varint(len(body)) + body


print("=== 1. 多个分段一起转换（离线）===")
import biliass
seg1 = elem(1000, "一") + elem(2000, "二", mode=5)
seg2 = elem(400000, "三") + elem(401000, "四", mode=4) + elem(402000, "五")
ass = biliass.convert_to_ass([seg1, seg2], *bilidl.DM_STAGE, input_format="protobuf", **bilidl.DM_STYLE)
n = ass.count("\nDialogue:")
print("条数", "OK" if n == 5 else f"错误：{n}")
print("样式", "OK" if "Microsoft YaHei, 38" in ass else "错误")

print("=== 2. 联网下载、跳过已存在 ===")
api = bilidl.Api()
BV, CID, DUR = "BV1GJ411x7h7", 137649199, 213
print(bilidl.download_danmaku(api, CID, root, "t", DUR))
print(bilidl.download_danmaku(api, CID, root, "t", DUR))  # 第二次不重新下载
path = bilidl.dm_path(root, "t")
print("文件", "OK" if os.path.getsize(path) > 1000 else "太小", path)

print("=== 3. 没装 biliass 时只给说明，不抛异常 ===")
real_import = builtins.__import__


def no_biliass(name, *a, **k):
    if name == "biliass":
        raise ImportError(name)
    return real_import(name, *a, **k)


builtins.__import__ = no_biliass
try:
    r = bilidl.download_danmaku(api, CID, root, "none", DUR)
finally:
    builtins.__import__ = real_import
print("OK" if r[0] is None and "biliass" in r[1] else f"错误：{r}")
