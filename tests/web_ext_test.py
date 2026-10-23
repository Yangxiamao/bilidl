"""Chrome 插件用到的接口：/api/token、/api/sync_cookie、记住清晰度、/?url= 预填。
需要先启动 bilidl_web.py --no-browser。用法: web_ext_test.py <输出目录> [端口]"""
import http.client, json, os, sys, time
OUT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
HOST = f"127.0.0.1:{PORT}"
CONFIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
fails = []


def req(method, path, body=None, token=None, host=HOST, origin=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
    c.putrequest(method, path, skip_host=True)
    c.putheader("Host", host)
    data = json.dumps(body).encode() if body is not None else b""
    if token: c.putheader("X-Token", token)
    if origin: c.putheader("Origin", origin)
    c.putheader("Content-Type", "application/json"); c.putheader("Content-Length", str(len(data)))
    c.endheaders(data)
    r = c.getresponse(); raw = r.read()
    return r.status, raw


def check(name, ok, detail=""):
    print("OK  " if ok else "FAIL", name, detail)
    if not ok: fails.append(name)


# token
s, raw = req("GET", "/api/token")
tok = json.loads(raw).get("token", "") if s == 200 else ""
check("token 无 Origin", s == 200 and len(tok) > 10, s)
s, raw = req("GET", "/api/token", origin="chrome-extension://abcdefghijklmnop")
check("token 插件 Origin", s == 200 and json.loads(raw)["token"] == tok, s)
check("token 网页 Origin 被拒", req("GET", "/api/token", origin="https://evil.example")[0] == 403)
check("token 错误 Host 被拒", req("GET", "/api/token", host="evil.com:8765")[0] == 403)
s, raw = req("GET", "/", token=None)
check("页面里的 token 一致", s == 200 and f'const TOKEN = "{tok}"'.encode() in raw)
check("/?url= 也返回页面", req("GET", "/?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1GJ411x7h7")[0] == 200)


def J(method, path, body=None):
    s, raw = req(method, path, body, tok); return s, json.loads(raw)


s, st = J("GET", "/api/status")
check("token 能调用接口", s == 200, s)
check("status 带 qn", st.get("qn") in (16, 32, 64, 74, 80, 112, 116, 120, 125, 126, 127), st.get("qn"))

# sync_cookie：不改真实 cookie，只测空值和格式错误
s, d = J("POST", "/api/sync_cookie", {"sessdata": ""}); check("sync 空值 400", s == 400, d)
s, d = J("POST", "/api/sync_cookie", {"sessdata": "a b;c"}); check("sync 格式错误 400", s == 400, d)
check("sync 无 token 被拒", req("POST", "/api/sync_cookie", {"sessdata": "x"})[0] == 403)
cookie_file = os.path.join(os.path.dirname(CONFIG), "sessdata.txt")
if os.path.exists(cookie_file):  # 发送当前保存的值，应该什么都不改（不打印 cookie）
    with open(cookie_file, encoding="utf-8") as f:
        cur = f.read().strip()
    if cur:
        s, d = J("POST", "/api/sync_cookie", {"sessdata": cur}); check("sync 相同值不改", s == 200 and d == {"changed": False})

# 记住清晰度：下一个 360P 任务后 status.qn 变成 16；测完恢复 config.json
with open(CONFIG, "rb") as f:
    saved = f.read()
try:
    s, d = J("POST", "/api/info", {"url": "https://www.bilibili.com/video/BV1GJ411x7h7"})
    check("info", s == 200, d.get("title") if s == 200 else d)
    s, d = J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 16, "out_dir": OUT, "threads": 2})
    check("download", s == 200, d)
    if s == 200:
        jid = d["id"]
        J("POST", "/api/cancel", {"id": jid})
        t0 = time.time()
        while time.time() - t0 < 30 and J("GET", "/api/jobs")[1]["jobs"][-1]["status"] in ("queued", "running"):
            time.sleep(0.2)
        J("POST", "/api/remove", {"id": jid})
    check("记住 qn", J("GET", "/api/status")[1].get("qn") == 16)
finally:
    with open(CONFIG, "wb") as f:
        f.write(saved)
check("恢复后 qn", J("GET", "/api/status")[1].get("qn") == st.get("qn"))

print("\n全部通过" if not fails else f"\n失败 {len(fails)} 项：{fails}")
sys.exit(1 if fails else 0)
