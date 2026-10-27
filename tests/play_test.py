"""在线播放代理（/play/）的正确性：经代理和直连取同样的 Range 逐字节比较、同一块并发请求只拉一次、
CORS 和目标链接校验、/api/play_stats。需要先启动 bilidl_web.py --no-browser。用法: play_test.py [端口] [BV号]"""
import http.client, json, os, sys, threading, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bilidl

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
BVID = sys.argv[2] if len(sys.argv) > 2 else "BV1Q24y1j7YT"
HOST = f"127.0.0.1:{PORT}"
ORIGIN = "https://www.bilibili.com"
fails = []


def check(name, ok, detail=""):
    print("OK  " if ok else "FAIL", name, detail, flush=True)
    if not ok:
        fails.append(name)


def req(method, path, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
    c.putrequest(method, path, skip_host=True)
    headers = {"Host": HOST, **(headers or {})}
    for k, v in headers.items():
        c.putheader(k, v)
    c.endheaders()
    r = c.getresponse()
    return r.status, dict(r.getheaders()), r.read()


def play(url, rng, origin="null"):
    h = {"Range": rng} if rng else {}
    if origin:
        h["Origin"] = origin
    return req("GET", "/play/" + url, h)


def direct(url, rng):
    r = urllib.request.Request(url, headers={"User-Agent": bilidl.UA, "Referer": "https://www.bilibili.com/", "Range": rng})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return resp.read()


api = bilidl.Api()
cid = bilidl.video_meta(api, BVID)[2][0][2]
dash = bilidl.playurl(api, BVID, cid)["dash"]
v = max(dash["video"], key=lambda x: (x["id"], x["bandwidth"]))
a = max(dash["audio"], key=lambda x: x["bandwidth"])
vurl, aurl = v["baseUrl"], a["baseUrl"]  # 和网页播放器一样用 API 给的原始链接（通常是慢节点）
print("视频:", bilidl.host_of(vurl), vurl.split("?")[0].rsplit("/", 1)[-1], "| 音频:", aurl.split("?")[0].rsplit("/", 1)[-1])

# 1. ping、CORS、校验
s, h, _ = req("GET", "/play/ping", {"Origin": ORIGIN})
check("ping 204 + CORS", s == 204 and h.get("Access-Control-Allow-Origin") == ORIGIN, (s, h.get("Access-Control-Allow-Origin")))
check("ping 无 Origin", req("GET", "/play/ping")[0] == 204)
check("ping 外站 Origin 被拒", req("GET", "/play/ping", {"Origin": "https://evil.example"})[0] == 403)
s, h, _ = req("OPTIONS", "/play/" + vurl, {"Origin": ORIGIN, "Access-Control-Request-Method": "GET",
                                          "Access-Control-Request-Private-Network": "true"})
check("OPTIONS 预检", s == 204 and h.get("Access-Control-Allow-Private-Network") == "true" and "Range" in h.get("Access-Control-Allow-Headers", ""), s)
check("OPTIONS 外站被拒", req("OPTIONS", "/play/" + vurl, {"Origin": "https://evil.example"})[0] == 403)
check("错误 Host 被拒", req("GET", "/play/ping", {"Host": "evil.com"})[0] in (400, 403))
for bad in ("https://evil.example/upgcxcode/x.m4s", "http://upos-sz-mirrorhw.bilivideo.com/upgcxcode/x.m4s",
            "https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/x.mp4", "https://upos-sz-mirrorhw.bilivideo.com:8443/x.m4s",
            "file:///C:/Windows/win.ini"):
    check("拒绝目标 " + bad[:50], play(bad, "bytes=0-9")[0] == 400)
check("play_stats 无 token 被拒", req("GET", "/api/play_stats")[0] == 403)

# 2. 逐字节比较
size = int(urllib.request.urlopen(urllib.request.Request(vurl, headers={"User-Agent": bilidl.UA, "Referer": "https://www.bilibili.com/",
                                                                         "Range": "bytes=0-0"}), timeout=20).headers["Content-Range"].split("/")[1])
C = bilidl.CHUNK
cases = ["bytes=0-1467", "bytes=1468-28421", f"bytes={C - 100}-{C + 99}", f"bytes={3 * C + 5}-{5 * C + 17}",
         f"bytes={size - 1000}-{size - 1}", f"bytes={size - 500}-", f"bytes={size - 10}-{size + 5000}"]
for rng in cases:
    t = time.time()
    s, h, body = play(vurl, rng)
    want = direct(vurl, rng)
    check(f"{rng:28s} 一致", s == 206 and body == want and h.get("Content-Range", "").endswith(f"/{size}")
          and h.get("Access-Control-Allow-Origin") == "null", f"{s} {len(body)}B {time.time() - t:.2f}s {h.get('Content-Range')}")
check("超出文件 416", play(vurl, f"bytes={size}-{size + 10}")[0] == 416)
s, h, body = play(aurl, "bytes=0-99999")
check("音频一致", s == 206 and body == direct(aurl, "bytes=0-99999"), s)
# 播放器有时只用 akamai 的链接：代理应换成快节点去拉，而不是走总带宽只有约 1 MB/s 的 akamai
low = min(dash["video"], key=lambda x: (x["id"], x["bandwidth"]))
akam = next((u for u in [low["baseUrl"]] + (low.get("backupUrl") or []) if "akamaized" in u), None)
if akam:
    s, h, body = play(akam, "bytes=0-299999")
    check("akamai 链接一致", s == 206 and body == direct(akam, "bytes=0-299999"), s)

# 3. 并发请求同一个还没拉过的块，只拉一次
mid = (size // 2 // C) * C
res = [None] * 8
ths = [threading.Thread(target=lambda i=i: res.__setitem__(i, play(vurl, f"bytes={mid + i * 1000}-{mid + i * 1000 + 999}"))) for i in range(8)]
[t.start() for t in ths]
[t.join() for t in ths]
want = direct(vurl, f"bytes={mid}-{mid + 8999}")
check("并发 8 个请求都正确", all(r[0] == 206 and r[2] == want[i * 1000:(i + 1) * 1000] for i, r in enumerate(res)))

# 4. 统计：等预读停下来后，拉取次数应等于缓存的块数（没有重复拉取）
tok = json.loads(req("GET", "/api/token")[2])["token"]
for _ in range(60):
    st = json.loads(req("GET", "/api/play_stats", {"X-Token": tok})[2])
    r = next(x for x in st["resources"] if x["name"] == vurl.split("?")[0].rsplit("/", 1)[-1])
    time.sleep(1)
    st2 = json.loads(req("GET", "/api/play_stats", {"X-Token": tok})[2])
    r2 = next(x for x in st2["resources"] if x["name"] == r["name"])
    if r2["fetches"] == r["fetches"]:
        break
print("统计:", {k: r2[k] for k in ("size", "pos", "cached", "chunks", "fetches", "hedges", "ahead", "window", "host")})
print("节点速度:", [(x["host"].replace(".bilivideo.com", ""), round(x["speed"] / 1e6, 2)) for x in st2["hosts"]], "冷却:", st2["cooling"])
# 对冲（播放器在等的块拉得慢时另找节点再拉一份）的块可能拉到两份，其余每块只拉一次
check("没有重复拉取", r2["chunks"] <= r2["fetches"] <= r2["chunks"] + r2["hedges"], (r2["fetches"], r2["chunks"], r2["hedges"]))
check("有预读", r2["ahead"] > 0 and r2["chunks"] > 10, r2["ahead"])
check("内存统计", st2["mem"] == sum(x["cached"] for x in st2["resources"]), st2["mem"])
if akam:
    ra = next(x for x in st2["resources"] if x["name"] == akam.split("?")[0].rsplit("/", 1)[-1])
    check("akamai 链接换成快节点拉取", ra["host"] and "akamaized" not in ra["host"], ra["host"])

print("\n全部通过" if not fails else f"\n失败 {len(fails)} 项: {fails}")
sys.exit(1 if fails else 0)
