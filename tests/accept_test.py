import os, re, subprocess, sys, threading, time, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # 仓库根目录
import bilidl
root = sys.argv[1]
BV = "BV1GJ411x7h7"
api = bilidl.Api()
ps = api.get(f"https://api.bilibili.com/x/player/pagelist?bvid={BV}", login=False)["data"]
cid = ps[0]["cid"]
def probe(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "compact", p], capture_output=True, text=True)
    return " | ".join(r.stdout.split())
def collect():
    logs = []
    return logs, lambda *a: logs.append(" ".join(map(str, a)))

print("=== 2. 断点续传（1080P，视频下到 >=20MB 时取消）===")
out = os.path.join(root, "resume"); logs, lg = collect()
cancel = threading.Event(); streams = []
def watch():
    while not cancel.is_set():
        if streams and streams[0].done >= 20 << 20: cancel.set()
        time.sleep(0.005)
threading.Thread(target=watch, daemon=True).start()
try:
    bilidl.download_page(api, BV, cid, out, "t", 80, cancel=cancel, log=lg, on_streams=lambda q, s: streams.extend(s))
except bilidl.Cancelled:
    print("取消时视频进度:", streams[0].done, "/", streams[0].size)
logs.clear()
t0 = time.time()
p, q = bilidl.download_page(api, BV, cid, out, "t", 80, log=lg)
print("续传完成", q, f"{time.time()-t0:.1f}s;", [l for l in logs if "待下载" in l])
print("ffprobe:", probe(p))

print("=== 3. 链接过期（签名被篡改）===")
def refresh():
    d = bilidl.playurl(api, BV, cid, 16)["dash"]
    v, _ = bilidl.pick_streams(d, 16)
    return bilidl.mirrors(v)
def tamper(u):
    sp = urllib.parse.urlsplit(u)
    q = urllib.parse.parse_qsl(sp.query, keep_blank_values=True)
    q = [(k, ("0" * len(v) if k in ("upsig", "deadline") else v)) for k, v in q]
    return sp._replace(query=urllib.parse.urlencode(q)).geturl()
os.makedirs(os.path.join(root, "expire"), exist_ok=True)
for case in ("总大小阶段", "分段下载阶段"):
    logs, lg = collect()
    st = bilidl.Stream("视频", os.path.join(root, "expire", f"{case}.m4s"), refresh)
    d = bilidl.Downloader(api, st, None, lg)
    print("签名参数:", [k for k, _ in urllib.parse.parse_qsl(urllib.parse.urlsplit(d.urls[0]).query) if "sig" in k or k == "deadline"])
    if case == "总大小阶段":
        d.urls = [tamper(u) for u in d.urls]
    else:
        real = d.total_size(); d.urls = [tamper(u) for u in d.urls]; d.total_size = lambda: real
    t0 = time.time(); d.run()
    print(case, "完成" if st.status == "done" and st.done == st.size else "失败", f"{time.time()-t0:.1f}s",
          "| 刷新次数:", sum("链接已刷新" in l for l in logs),
          "| 失败示例:", next((l for l in logs if "失败" in l), "")[:120])

print("=== 4. 坏节点（最前面放一个不存在的域名）===")
for label, hosts in (("正常", None), ("坏节点在前", ["upos-sz-nonexistent-xyz.bilivideo.com"] + bilidl.FAST_HOSTS)):
    out = os.path.join(root, "bad_" + str(hosts is None)); logs, lg = collect()
    sts = []
    t0 = time.time()
    p, q = bilidl.download_page(api, BV, cid, out, "t", 80, log=lg, hosts=hosts, on_streams=lambda q, s: sts.extend(s))
    print(label, f"{time.time()-t0:.1f}s", "| 节点:", sts[0].host, "|", [l[:110] for l in logs if "降权" in l])
    print("  ffprobe:", probe(p))
