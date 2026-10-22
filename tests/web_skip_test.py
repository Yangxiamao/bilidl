"""网页界面：任务进行中单独跳过/恢复某个分P。需要先启动 bilidl_web.py --no-browser。

用法: python web_skip_test.py <输出目录> [端口]
用 1 个线程下载（约 1.5 MB/s），才来得及在分P下到一半时跳过。
"""
import http.client, json, os, re, sys, time
OUT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
BV = "BV1Q24y1j7YT"  # 2 个分P，各约 3 分钟


def req(method, path, body=None, token=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
    c.putrequest(method, path, skip_host=True)
    c.putheader("Host", f"127.0.0.1:{PORT}")
    data = json.dumps(body).encode() if body is not None else b""
    if token: c.putheader("X-Token", token)
    c.putheader("Content-Type", "application/json"); c.putheader("Content-Length", str(len(data)))
    c.endheaders(data)
    r = c.getresponse()
    return r.status, r.read()


tok = re.search(rb'const TOKEN = "([^"]+)"', req("GET", "/")[1]).group(1).decode()
def J(method, path, body=None):
    s, raw = req(method, path, body, tok); return s, json.loads(raw)
def job(jid):
    return next(j for j in J("GET", "/api/jobs")[1]["jobs"] if j["id"] == jid)
def states(j):
    return [p["state"] for p in j["pages"]]
def wait(jid, cond, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = job(jid)
        if cond(j): return j
        time.sleep(0.05)
    raise SystemExit(f"超时：{states(j)} {j['status']}")
def check(name, ok, *info):
    print("OK  " if ok else "FAIL", name, *info)
    if not ok: check.failed = True
check.failed = False
def start(sub, pages):
    s, d = J("POST", "/api/download", {"bvid": BV, "pages": pages, "qn": 16, "threads": 1,
                                       "out_dir": os.path.join(OUT, sub)})
    assert s == 200, d
    return d["id"]


s, d = J("POST", "/api/info", {"url": BV}); print("info", s, d.get("title"), len(d.get("pages", [])))

# A. 跳过排队的 P2 → P1 下载中恢复 P2 → 跳过下载中的 P1 → 任务结束后恢复 P1（续传）
jid = start("a", [1, 2])
s, d = J("POST", "/api/skip", {"id": jid, "page": 2}); check("跳过排队的 P2", s == 200, d)
j = wait(jid, lambda j: j["pages"][0]["state"] == "running" and j["pages"][0]["done"] > 0)
check("P2 已跳过、不算进总大小", states(j)[1] == "skipped" and j["total"] == j["pages"][0]["total"], states(j), j["total"])
s, d = J("POST", "/api/unskip", {"id": jid, "page": 2}); check("任务进行中恢复 P2", s == 200, d)
check("P2 回到排队", states(job(jid))[1] == "queued")
s, d = J("POST", "/api/skip", {"id": jid, "page": 1}); check("跳过下载中的 P1", s == 200, d)
s, d = J("POST", "/api/skip", {"id": jid, "page": 1}); print("   重复跳过:", s, d)
j = wait(jid, lambda j: j["status"] not in ("queued", "running"), 300)
p1_done = j["pages"][0]["done"]
check("P1 跳过、P2 下完、任务算完成", states(j) == ["skipped", "done"] and j["status"] == "done",
      states(j), j["status"], "P1 已下", p1_done)
s, d = J("POST", "/api/skip", {"id": jid, "page": 2}); check("已完成的分P不能跳过", s == 400, d)
s, d = J("POST", "/api/unskip", {"id": jid, "page": 2}); check("没跳过的分P不能恢复", s == 400, d)
s, d = J("POST", "/api/skip", {"id": jid, "page": 9}); check("不存在的分P", s == 404, d)
kept = [n for _, _, fs in os.walk(os.path.join(OUT, "a")) for n in fs if n.startswith("P1 ") and n.endswith(".state.json")]
check("跳过后保留了 P1 的续传进度", p1_done > 0 and kept, kept)
s, d = J("POST", "/api/unskip", {"id": jid, "page": 1}); check("任务结束后恢复 P1，重新排队", s == 200, d)
j = wait(jid, lambda j: j["status"] not in ("queued", "running"), 300)
check("P1 下完", states(j) == ["done", "done"] and j["status"] == "done", states(j), j["status"])

# B. 两个分P都跳过 → 任务算「已取消」
jid = start("b", [1, 2])
J("POST", "/api/skip", {"id": jid, "page": 2})
wait(jid, lambda j: j["pages"][0]["state"] == "running")
J("POST", "/api/skip", {"id": jid, "page": 1})
j = wait(jid, lambda j: j["status"] not in ("queued", "running"))
check("全部跳过", states(j) == ["skipped", "skipped"] and j["status"] == "cancelled" and j["total"] == 0,
      states(j), j["status"], j["total"])

# C. 取消整个任务时，下载中的分P算「已取消」（可以重试），不是「已跳过」
jid = start("c", [1, 2])
wait(jid, lambda j: j["pages"][0]["state"] == "running" and j["pages"][0]["done"] > 0)
J("POST", "/api/cancel", {"id": jid})
j = wait(jid, lambda j: j["status"] not in ("queued", "running"))
check("取消整个任务", states(j) == ["cancelled", "cancelled"] and j["status"] == "cancelled", states(j), j["status"])
s, d = J("POST", "/api/skip", {"id": jid, "page": 1}); check("已取消的分P不能跳过", s == 400, d)

for jj in J("GET", "/api/jobs")[1]["jobs"]:
    J("POST", "/api/remove", {"id": jj["id"]})
print("全部通过" if not check.failed else "有失败")
