import http.client, json, re, sys, time
OUT = sys.argv[1]
def req(method, path, body=None, token=None, host="127.0.0.1:8765"):
    c = http.client.HTTPConnection("127.0.0.1", 8765, timeout=60)
    c.putrequest(method, path, skip_host=True)
    c.putheader("Host", host)
    data = json.dumps(body).encode() if body is not None else b""
    if token: c.putheader("X-Token", token)
    c.putheader("Content-Type", "application/json"); c.putheader("Content-Length", str(len(data)))
    c.endheaders(data)
    r = c.getresponse(); raw = r.read()
    return r.status, raw
st, html = req("GET", "/")
tok = re.search(rb'const TOKEN = "([^"]+)"', html).group(1).decode()
print("GET /", st, "token len", len(tok), "placeholder gone:", b"__TOKEN__" not in html)
print("bad host /", req("GET", "/", host="evil.com:8765")[0])
print("no token jobs", req("GET", "/api/jobs")[0])
print("wrong token jobs", req("GET", "/api/jobs", token="x")[0])
print("bad host+token", req("GET", "/api/jobs", token=tok, host="evil.com")[0])
def J(method, path, body=None):
    s, raw = req(method, path, body, tok); d = json.loads(raw); return s, d
s, d = J("GET", "/api/status"); print("status", s, {k: d[k] for k in ("login", "vip", "ffmpeg", "default_dir")})
s, d = J("POST", "/api/info", {"url": "not a video"}); print("info bad", s, d)
s, d = J("POST", "/api/info", {"url": "https://www.bilibili.com/video/BV1GJ411x7h7/?p=1"})
print("info", s, d["title"], len(d["pages"]), "url_page", d["url_page"], [q["name"] for q in d["qualities"]], round(d["audio_kbps"]))
s, d = J("POST", "/api/open", {"path": r"C:\Windows"}); print("open disallowed", s, d)
s, d = J("POST", "/api/cookie", {"sessdata": "a b;c"}); print("cookie invalid", s, d)
s, d = J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 16, "out_dir": "relative"}); print("relative dir", s, d)
s, d = J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 16, "out_dir": OUT}); print("download", s, d)
jid = d["id"]
s, d = J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 16, "out_dir": OUT}); print("duplicate", s, d)
# 视频下到一部分时取消
t0 = time.time()
while time.time() - t0 < 30:
    j = J("GET", "/api/jobs")[1]["jobs"][-1]
    if j["status"] == "running" and j["done"] > 0: break
    time.sleep(0.03)
print("before cancel:", j["status"], j["pages"][0]["stage"], j["done"], j["total"])
print("cancel", J("POST", "/api/cancel", {"id": jid}))
while True:
    j = J("GET", "/api/jobs")[1]["jobs"][-1]
    if j["status"] != "running": break
    time.sleep(0.2)
print("after cancel:", j["status"], j["pages"][0]["state"], j["done"], "/", j["total"], "|", j["log"])
print("retry", J("POST", "/api/retry", {"id": jid}))
last, seq = -1, []
while True:
    j = J("GET", "/api/jobs")[1]["jobs"][-1]
    seq.append((round(j["done"]/1e6, 1), round(j["total"]/1e6, 1), round(j["speed"]/1e6, 2), j["eta"] and round(j["eta"]), j["pages"][0]["stage"]))
    if j["status"] not in ("queued", "running"): break
    time.sleep(0.25)
print("progress samples:", seq[:: max(1, len(seq)//12)], "... final", seq[-1])
mono = all(a[0] <= b[0] for a, b in zip(seq, seq[1:]))
print("final:", j["status"], j["pages"][0]["state"], j["pages"][0]["qname"], j["done"], j["total"], "monotonic", mono)
s, d = J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 16, "out_dir": OUT}); print("again", s, d)
time.sleep(2)
j = J("GET", "/api/jobs")[1]["jobs"][-1]; print("again job:", j["status"], j["pages"][0]["state"])
print("remove", J("POST", "/api/remove", {"id": j["id"]}), "jobs left", len(J("GET", "/api/jobs")[1]["jobs"]))
s, d = J("POST", "/api/retry", {"id": jid}); print("retry done job", s, d)
