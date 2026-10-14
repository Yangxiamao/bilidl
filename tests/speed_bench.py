"""测速：下载一个分P的视频流（默认 1080P），N 秒后取消或下完为止，报告速度和各节点命中次数。

用法: speed_bench.py <输出目录> <秒数> [线程数] [BV号] [分P]
例如: speed_bench.py %TEMP%\\bench 25 16
默认视频是 BV1Q24y1j7YT 的 P1。视频较短时可能不到 N 秒就下完，这时按"首字节到下完"的平均速度报告。
测完请删除输出目录（里面会有一个预分配了完整大小的 .m4s 文件）。
"""
import inspect, os, sys, threading, time, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # 仓库根目录
import bilidl

out, secs = sys.argv[1], float(sys.argv[2])
workers = int(sys.argv[3]) if len(sys.argv) > 3 else None
bvid = sys.argv[4] if len(sys.argv) > 4 else "BV1Q24y1j7YT"
page = int(sys.argv[5]) if len(sys.argv) > 5 else 1
QN = 80  # 1080P；不可用时（例如未登录）自动取最高可用清晰度
os.makedirs(out, exist_ok=True)

logs = []
def lg(*a): logs.append(time.strftime("%H:%M:%S ") + " ".join(map(str, a)))

api = bilidl.Api()
ps = api.get(f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}", login=False)["data"]
cid = next(p["cid"] for p in ps if p["page"] == page)

def refresh():
    d = bilidl.playurl(api, bvid, cid, QN)["dash"]
    v, _ = bilidl.pick_streams(d, QN)
    return bilidl.mirrors(v)

d = bilidl.playurl(api, bvid, cid, QN)["dash"]
v, _ = bilidl.pick_streams(d, QN)
print(f"{bvid} P{page}: {bilidl.QN_NAME.get(v['id'], v['id'])} {v['width']}x{v['height']}")

st = bilidl.Stream("视频", os.path.join(out, "bench.video.m4s"), refresh)
cancel = threading.Event()
kw = {"workers": workers} if workers and "workers" in inspect.signature(bilidl.Downloader).parameters else {}
dl = bilidl.Downloader(api, st, cancel, lg, **kw)
print("线程:", kw.get("workers", bilidl.WORKERS), "| 节点顺序:", [urllib.parse.urlsplit(u).hostname for u in dl.urls])

marks = []  # (距首字节的秒数, 已下载字节)
def timer():
    while st.net == 0 and not cancel.is_set() and st.status != "done":
        time.sleep(0.02)
    t0 = time.time()
    while time.time() - t0 < secs and st.status != "done":
        marks.append((time.time() - t0, st.net))
        time.sleep(0.5)
    marks.append((time.time() - t0, st.net))
    cancel.set()
threading.Thread(target=timer, daemon=True).start()

try:
    dl.run()
    finished = True
except bilidl.Cancelled:
    finished = False
time.sleep(0.6)  # 等计时线程记下最后一个点

a, b = marks[0], marks[-1]
steady = next((m for m in marks if m[0] >= 3), None)
print(f"{'已下完' if finished else '已取消'}：下载 {st.net/1e6:.1f} MB / 文件 {st.size/1e6:.1f} MB，用时 {b[0]:.1f}s")
print(f"平均速度（首字节起）: {(b[1]-a[1])/max(b[0]-a[0], 1e-6)/1e6:.2f} MB/s")
if not finished and steady and b[0] - steady[0] >= 2:  # 已下完时，3 秒后只剩收尾的几个分段，没有参考意义
    print(f"稳态速度（3s 之后）: {(b[1]-steady[1])/(b[0]-steady[0])/1e6:.2f} MB/s")
print("各节点成功分段数:", dl.host_stats())
for l in logs:
    if "待下载" in l or "失败" in l or "降权" in l:
        print(l)
