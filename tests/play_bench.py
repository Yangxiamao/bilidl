"""模拟网页播放器按码率 × 倍速取数，比较「直连 API 给的节点」和「经 /play/ 代理」是否卡顿。
需要先启动 bilidl_web.py --no-browser。用法: play_bench.py [端口] [BV号] [mode=both|proxy|direct]

播放器模型（按 docs/PLAYBACK.md 里实测的 B 站播放器行为）：一次只有一个视频分段请求在飞，每段约 2 秒的媒体数据，
缓冲到领先播放位置 72 秒的媒体数据就停下来等；缓冲够 2 秒开始播放；缓冲耗尽算一次卡顿，缓冲回到 1 秒再继续。
流量：代理模式约「码率 × 倍速 × 时长」再加约 90 秒的预读。"""
import http.client, json, os, sys, threading, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bilidl

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
BVID = sys.argv[2] if len(sys.argv) > 2 else "BV1bE41127s6"  # 约 2.5 小时的 4K 演唱会
MODE = sys.argv[3] if len(sys.argv) > 3 else "both"
BUFFER_SEC, SEG_SEC, START_SEC, RESUME_SEC = 72, 2, 2, 1
# (说明, 倍速, 时长秒, 跳转到文件的比例或 None)
PHASES = [("1x", 1, 25, None), ("切到 2x", 2, 30, None), ("跳到 60% 后 2x", 2, 25, 0.6), ("切到 3x", 3, 25, None)]
HEADERS = {"User-Agent": bilidl.UA, "Referer": "https://www.bilibili.com/"}


def token():
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    c.request("GET", "/api/token")
    return json.loads(c.getresponse().read())["token"]


def stats(tok, name):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    c.request("GET", "/api/play_stats", headers={"X-Token": tok})
    st = json.loads(c.getresponse().read())
    return next((r for r in st["resources"] if r["name"] == name), None)


def get(url, start, end, via_proxy):
    if via_proxy:
        c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
        c.request("GET", "/play/" + url, headers={"Range": f"bytes={start}-{end}", "Origin": "null"})
        r = c.getresponse()
        data = r.read()
        if r.status != 206:
            raise IOError(f"HTTP {r.status} {data[:100]}")
        return data
    req = urllib.request.Request(url, headers={**HEADERS, "Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def simulate(url, size, bps, via_proxy, label):
    """bps：1 倍速时每秒消耗的字节数（流的码率）。"""
    lock = threading.Lock()
    s = {"play": 0.0, "fetch": 0, "speed": 1, "playing": False, "stall_t0": None, "stop": False}
    log = []  # 每个阶段的统计

    def fetcher():
        while not s["stop"]:
            with lock:
                buf = (s["fetch"] - s["play"]) / bps
                pos = s["fetch"]
            if buf >= BUFFER_SEC or pos >= size:
                time.sleep(0.05)
                continue
            end = min(pos + int(SEG_SEC * bps), size) - 1
            t0 = time.time()
            try:
                data = get(url, pos, end, via_proxy)
            except Exception as e:
                cur["errors"] += 1
                print("   请求出错:", str(e)[:80], flush=True)
                time.sleep(0.5)
                continue
            dt = time.time() - t0
            with lock:
                if s["fetch"] == pos:  # 期间没有跳转
                    s["fetch"] = pos + len(data)
                    cur["lat"].append(dt)
                    cur["bytes"] += len(data)

    def phase_stats():
        return {"stalls": 0, "stall_time": 0.0, "lat": [], "bytes": 0, "errors": 0, "ahead": [], "startup": None}

    th = threading.Thread(target=fetcher, daemon=True)
    cur = phase_stats()
    t_start = time.time()
    th.start()
    tok = token() if via_proxy else None
    name = url.split("?")[0].rsplit("/", 1)[-1]
    for desc, speed, dur, seek in PHASES:
        cur = phase_stats()
        t_phase = time.time()
        with lock:
            s["speed"] = speed
            if seek is not None:
                p = int(size * seek) // bilidl.CHUNK * bilidl.CHUNK + 12345
                s["play"], s["fetch"], s["playing"], s["stall_t0"] = float(p), p, False, None
                t_start = time.time()
        last, next_stat = time.time(), time.time() + 2
        while time.time() - t_phase < dur:
            time.sleep(0.05)
            now = time.time()
            with lock:
                buf = (s["fetch"] - s["play"]) / bps
                if not s["playing"]:
                    need = START_SEC if s["stall_t0"] is None else RESUME_SEC
                    if buf >= need or s["fetch"] >= size:
                        if s["stall_t0"] is not None:
                            cur["stall_time"] += now - s["stall_t0"]
                        elif cur["startup"] is None:
                            cur["startup"] = now - t_start
                        s["playing"], s["stall_t0"] = True, None
                else:
                    s["play"] = min(s["play"] + bps * speed * (now - last), s["fetch"])
                    if s["play"] >= s["fetch"] and s["fetch"] < size:
                        s["playing"], s["stall_t0"] = False, now
                        cur["stalls"] += 1
            last = now
            if via_proxy and now >= next_stat:
                next_stat = now + 2
                r = stats(tok, name)
                if r and r["ahead_sec"] is not None:
                    cur["ahead"].append(r["ahead_sec"])
        with lock:
            if s["stall_t0"] is not None:  # 阶段结束时还卡着
                cur["stall_time"] += time.time() - max(s["stall_t0"], t_phase)
                s["stall_t0"] = time.time()
            buf = (s["fetch"] - s["play"]) / bps
        lat = sorted(cur["lat"])
        p = lambda q: lat[min(int(len(lat) * q), len(lat) - 1)] if lat else float("nan")
        ahead = f"预读领先 {min(cur['ahead']):.0f}~{max(cur['ahead']):.0f} 秒" if cur["ahead"] else ""
        startup = f"起播 {cur['startup']:.1f}s，" if cur["startup"] is not None else ""
        print(f"  [{label}] {desc:12s} {startup}卡顿 {cur['stalls']} 次共 {cur['stall_time']:.1f}s，"
              f"取数 {cur['bytes'] / dur / 1e6:.2f} MB/s（需要 {bps * speed / 1e6:.2f}），"
              f"请求耗时 p50 {p(0.5):.2f}s / p95 {p(0.95):.2f}s，缓冲 {buf:.0f}s，出错 {cur['errors']} 次 {ahead}", flush=True)
        log.append(cur)
    s["stop"] = True
    return log


api = bilidl.Api()
title, _, pages = bilidl.video_meta(api, BVID)
cid = pages[0][2]
dash = bilidl.playurl(api, BVID, cid)["dash"]
v = max(dash["video"], key=lambda x: (x["id"], x["bandwidth"]))
url = v["baseUrl"]  # 网页播放器用的就是 API 给的 baseUrl
req = urllib.request.Request(url, headers={**HEADERS, "Range": "bytes=0-0"})
with urllib.request.urlopen(req, timeout=20) as r:
    size = int(r.headers["Content-Range"].split("/")[1])
bps = size / dash["duration"]
print(f"{BVID} {title[:30]} | {bilidl.QN_NAME.get(v['id'], v['id'])} {v['codecs']} | {size / 1e9:.2f} GB，"
      f"平均码率 {bps / 1e6:.2f} MB/s | 原始节点 {bilidl.host_of(url)}", flush=True)
if MODE in ("both", "direct"):
    simulate(url, size, bps, False, "直连")
if MODE in ("both", "proxy"):
    simulate(url, size, bps, True, "代理")
