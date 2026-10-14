import http.client, json, re, sys, time
sys.stdout.reconfigure(encoding="utf-8")
OUT = sys.argv[1]
def req(method, path, body=None, tok=None):
    c = http.client.HTTPConnection("127.0.0.1", 8765, timeout=60)
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if tok: h["X-Token"] = tok
    c.request(method, path, data, h); r = c.getresponse(); return r.status, r.read()
for _ in range(50):
    try: st, html = req("GET", "/"); break
    except OSError: time.sleep(0.2)
tok = re.search(rb'const TOKEN = "([^"]+)"', html).group(1).decode()
J = lambda m, p, b=None: (lambda r: (r[0], json.loads(r[1])))(req(m, p, b, tok))
s, d = J("GET", "/api/status"); print("status threads", d["threads"], "max", d["max_threads"])
s, d = J("POST", "/api/info", {"url": "BV1GJ411x7h7"}); print("info", s, [q["name"] for q in d["qualities"]])
print("threads=99:", J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 80, "out_dir": OUT, "threads": 99}))
print("threads=abc:", J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 80, "out_dir": OUT, "threads": "abc"}))
print("download:", J("POST", "/api/download", {"bvid": "BV1GJ411x7h7", "pages": [1], "qn": 80, "out_dir": OUT, "threads": 16}))
nodes, speeds = set(), []
while True:
    j = J("GET", "/api/jobs")[1]["jobs"][-1]
    if j["node"]: nodes.add(j["node"])
    if j["speed"]: speeds.append(round(j["speed"] / 1e6, 1))
    if j["status"] not in ("queued", "running"): break
    time.sleep(0.2)
print("final", j["status"], "workers", j["workers"], "nodes seen", nodes, "speeds", speeds[-6:], "|", j["log"])
print("status threads after:", J("GET", "/api/status")[1]["threads"])
