import os, shutil, sys, time, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # 仓库根目录
import bilidl
sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]; BV = "BV1GJ411x7h7"
api = bilidl.Api()
cid = api.get(f"https://api.bilibili.com/x/player/pagelist?bvid={BV}", login=False)["data"][0]["cid"]
HOSTS = ["10.255.255.1"] + bilidl.FAST_HOSTS
def refresh():
    d = bilidl.playurl(api, BV, cid, 16)["dash"]; v, _ = bilidl.pick_streams(d, 16); return bilidl.mirrors(v, HOSTS)
def tamper(u):
    sp = urllib.parse.urlsplit(u)
    q = [(k, ("0" * len(v) if k in ("upsig", "deadline") else v)) for k, v in urllib.parse.parse_qsl(sp.query, keep_blank_values=True)]
    return sp._replace(query=urllib.parse.urlencode(q)).geturl()
for case in ("卡住节点在前", "卡住节点在前 + 签名过期"):
    shutil.rmtree(root, ignore_errors=True); os.makedirs(root)
    T = time.time()
    lg = lambda *a: print(f"   {time.time()-T:5.1f}s", *a, flush=True)
    st = bilidl.Stream("视频", os.path.join(root, "h.m4s"), refresh)
    d = bilidl.Downloader(api, st, None, lg)
    if "签名" in case: d.urls = [tamper(u) for u in d.urls]
    t = time.time(); size = d.total_size(); ts = time.time() - t
    d.total_size = lambda: size
    d.run()
    print(f"{case}: 获取大小 {ts:.1f}s，总计 {time.time()-T:.1f}s，完整={st.done == st.size}，节点统计 {d.host_stats()}", flush=True)
