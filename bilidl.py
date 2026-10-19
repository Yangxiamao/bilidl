"""bilidl - Bilibili 视频下载器（只访问 api.bilibili.com 和 CDN，不依赖 www.bilibili.com）

用法:
  bilidl <链接或BV号> --info                 查看各清晰度大小和字幕，不下载
  bilidl <链接或BV号> [-q 720] [-p 1,3-4] [-o 目录] [--sub [auto|all|zh,en]] [--danmaku] [--sub-only]
  bilidl --set-cookie <SESSDATA>             保存登录 cookie（720P 及以上、字幕需要）
  bilidl-web                                 打开网页界面

清晰度 -q: 360 / 480 / 720 / 1080 / 1080+ / 1080p60 / 4k / best（默认 720；不可用时自动降到最接近的较低清晰度）
"""
import argparse, glob, gzip, hashlib, html as htmllib, json, os, queue, re, shutil, subprocess, sys, threading, time
import urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HOME = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.path.join(HOME, "sessdata.txt")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
QUALITY = {"360": 16, "480": 32, "720": 64, "1080": 80, "1080+": 112, "1080p60": 116, "4k": 120, "best": 127}
QN_NAME = {16: "360P", 32: "480P", 64: "720P", 74: "720P60", 80: "1080P", 112: "1080P+", 116: "1080P60",
           120: "4K", 125: "HDR", 126: "杜比视界", 127: "8K"}
CODEC_PREF = {"avc": 7, "hevc": 12, "av1": 13}
CHUNK = 1 << 20  # CDN 常在 1~2 MB 后断开连接，所以用小分段。不要改：.state.json 按 idx*CHUNK 记录进度
WORKERS = 16     # CDN 按连接限速（每连接约 1.3~1.5 MB/s），总速度随并发近似线性增长
MAX_WORKERS = 32
# upos 链接的签名在 query 里，换域名照样有效；实测这几个节点最快（见 SPEEDUP.md）
FAST_HOSTS = ["upos-sz-mirror08c.bilivideo.com",
              "upos-sz-mirrorhw.bilivideo.com",
              "upos-sz-mirrorali.bilivideo.com"]
HOST_FAIL_LIMIT, HOST_COOLDOWN = 3, 60  # 节点连续失败 3 次就降到末尾，冷却 60 秒
REFRESH_MIN_INTERVAL = 10               # 多个线程同时遇到过期链接时只刷新一次，避免 playurl 被 412
# WBI 签名用的字符重排表（img_key + sub_key 按这个顺序取前 32 位）
WBI_MIX = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
           12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
           57, 62, 11, 36, 20, 34, 44, 52]
WBI_TTL = 3600  # 签名密钥每天换，缓存 1 小时足够


class Cancelled(Exception):
    pass


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def safe(name):
    return re.sub(r'[\\/:*?"<>|\r\n]', "_", name).strip()


def find_ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    cands = [os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe")]
    cands += glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin\ffmpeg.exe"))
    return next((c for c in cands if os.path.exists(c)), None)


class Api:
    def __init__(self):
        self.base = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
        spi = self._get("https://api.bilibili.com/x/frontend/finger/spi", self.base)["data"]
        self.guest = f"buvid3={spi['b_3']}; buvid4={spi['b_4']}"
        self.sess = open(COOKIE_FILE, encoding="utf-8").read().strip() if os.path.exists(COOKIE_FILE) else ""
        self._wbi = (0.0, "")  # (获取时间, mixin key)
        self._wbi_lock = threading.Lock()

    @staticmethod
    def _get(url, headers):
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)

    def _headers(self, login):
        cookie = self.guest + (f"; SESSDATA={self.sess}" if login and self.sess else "")
        return {**self.base, "Cookie": cookie}

    def get(self, url, login=True):
        return self._get(url, self._headers(login))

    def get_bytes(self, url, login=True):
        req = urllib.request.Request(url, headers=self._headers(login))
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read()

    def nav(self):
        d = self.get("https://api.bilibili.com/x/web-interface/nav")["data"]
        return {"login": bool(d.get("isLogin")), "vip": bool(d.get("vipStatus")), "uname": d.get("uname", "")}

    def wbi_query(self, params):
        """返回带 WBI 签名（wts + w_rid）的 query 字符串。密钥来自 nav 接口里两张图片的文件名。"""
        with self._wbi_lock:
            t, key = self._wbi
            if time.time() - t > WBI_TTL or not key:
                w = self.get("https://api.bilibili.com/x/web-interface/nav")["data"]["wbi_img"]
                raw = "".join(u.rsplit("/", 1)[1].split(".")[0] for u in (w["img_url"], w["sub_url"]))
                key = "".join(raw[i] for i in WBI_MIX)[:32]
                self._wbi = (time.time(), key)
        params = {k: re.sub(r"[!'()*]", "", str(v)) for k, v in {**params, "wts": int(time.time())}.items()}
        q = urllib.parse.urlencode(sorted(params.items()))
        return q + "&w_rid=" + hashlib.md5((q + key).encode()).hexdigest()


def resolve_target(s):
    """返回 (bvid, page)；支持 BV 号、视频链接、b23.tv 短链。"""
    s = s.strip()
    if "b23.tv" in s:
        req = urllib.request.Request(s if s.startswith("http") else "https://" + s, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            s = r.geturl()
    m = re.search(r"BV[0-9A-Za-z]{10}", s)
    if not m:
        raise ValueError(f"找不到 BV 号: {s}")
    p = re.search(r"[?&]p=(\d+)", s)
    return m.group(0), int(p.group(1)) if p else None


def video_meta(api, bvid):
    """返回 (title, owner, [(page, part, cid, duration)])。"""
    # 带登录 cookie 请求 view 接口容易触发 412 风控，所以用游客身份；仍失败则退回 pagelist 接口
    try:
        v = api.get(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}", login=False)["data"]
        return v["title"], v["owner"]["name"], [(p["page"], p["part"], p["cid"], p["duration"]) for p in v["pages"]]
    except Exception as e:
        log("view 接口失败，改用 pagelist:", e)
    ps = api.get(f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}", login=False)["data"]
    title, owner = bvid, ""
    try:  # 标题从网页 <title> 里取（主站连不上时就用 BV 号）
        req = urllib.request.Request(f"https://www.bilibili.com/video/{bvid}", headers={**api.base, "Cookie": api.guest})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
        html = body.decode("utf-8", "replace")
        m = re.search(r"<title[^>]*>(.*?)(?:_哔哩哔哩[^<]*)?</title>", html, re.S)
        if m and m.group(1).strip() and "视频去哪了" not in m.group(1):  # 后者是主站的错误页标题
            title = htmllib.unescape(m.group(1).strip())
        m = re.search(r'"owner":\{"mid":\d+,"name":"([^"]*)"', html)
        if m:
            owner = m.group(1)
    except Exception:
        pass
    return title, owner, [(p["page"], p["part"], p["cid"], p["duration"]) for p in ps]


def parse_pages(spec, n):
    if not spec:
        return list(range(1, n + 1))
    out = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out += range(int(a), int(b or a) + 1)
    return [p for p in out if 1 <= p <= n]


def playurl(api, bvid, cid, qn=127):
    return api.get(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=4048&fourk=1&qn={qn}")["data"]


def host_of(u):
    return urllib.parse.urlsplit(u).hostname or ""


def mirrors(s, hosts=None):
    """快节点在前（用 upos 链接换域名得到），API 原始链接放最后兜底。akamaized 的签名方式不同，不换域名。"""
    hosts = FAST_HOSTS if hosts is None else hosts
    urls = [u for u in [s.get("baseUrl") or s.get("base_url")] + (s.get("backupUrl") or s.get("backup_url") or []) if u]
    tmpl = next((u for u in urls if host_of(u).startswith("upos-") and host_of(u).endswith(".bilivideo.com")), None)
    fast = [urllib.parse.urlsplit(tmpl)._replace(netloc=h).geturl() for h in hosts] if tmpl else []
    return list(dict.fromkeys(fast + urls))


def all_audio(dash):
    flac = (dash.get("flac") or {}).get("audio")
    return (dash.get("audio") or []) + ([flac] if flac else [])


def pick_streams(dash, qn, codec="avc"):
    vids = dash["video"]
    ids = sorted({v["id"] for v in vids})
    chosen = max([i for i in ids if i <= qn] or [min(ids)])
    cands = [v for v in vids if v["id"] == chosen]
    v = next((x for x in cands if x.get("codecid") == CODEC_PREF[codec]), cands[0])
    a = max(all_audio(dash), key=lambda x: x["bandwidth"], default=None)
    return v, a


def probe_bitrates(api, bvid, pages, max_probe=8):
    """抽样前几个分P，返回 ({qn: (name, codec, res, kbps)}, audio_kbps)，用于按时长估算大小。"""
    acc, audio, total_dur = {}, 0.0, 0
    for _, _, cid, _ in pages[:max_probe]:
        dash = playurl(api, bvid, cid)["dash"]
        dur = dash["duration"]
        total_dur += dur
        for qn in {v["id"] for v in dash["video"]}:
            v, _ = pick_streams(dash, qn)
            e = acc.setdefault(qn, [v["codecs"].split(".")[0], f"{v['width']}x{v['height']}", 0.0])
            e[2] += v["bandwidth"] * dur
        _, a = pick_streams(dash, 127)
        audio += (a["bandwidth"] * dur) if a else 0
        time.sleep(0.3)
    td = max(total_dur, 1)
    q = {qn: (QN_NAME.get(qn, str(qn)), c, res, bits / td / 1000) for qn, (c, res, bits) in acc.items()}
    return q, audio / td / 1000


class Stream:
    """一个待下载的音频或视频流，同时是进度的载体。"""

    def __init__(self, label, path, refresh):
        self.label, self.path, self.refresh = label, path, refresh
        self.size = 0
        self.done = 0
        self.net = 0  # 本次实际从网络下载的字节（不含续传前已有的部分），用于算速度
        self.host = ""  # 最近一次成功下载分段的节点
        self.status = "pending"  # pending / running / done


class Downloader:
    def __init__(self, api, stream, cancel=None, log=log, workers=WORKERS):
        self.api, self.st, self.cancel, self.log = api, stream, cancel, log
        self.workers = max(1, min(int(workers), MAX_WORKERS))
        self.state_path = stream.path + ".state.json"
        self.lock = threading.Lock()
        self.urls = stream.refresh()
        self.refreshed = 0.0
        self.fails = {}  # host -> 连续失败次数（各线程共用）
        self.cool = {}   # host -> 冷却到期时间
        self.hits = {}   # host -> 成功分段数，仅用于统计

    def _sleep(self, sec):
        if self.cancel:
            if self.cancel.wait(sec):
                raise Cancelled()
        else:
            time.sleep(sec)

    def _pool(self):
        """可用节点按原顺序排列；冷却中的节点只在全部节点都冷却时才用。"""
        now = time.time()
        with self.lock:
            good = [u for u in self.urls if self.cool.get(host_of(u), 0) <= now]
            return good or list(self.urls)

    def _ok(self, u, chunk=True):
        h = host_of(u)
        with self.lock:
            self.fails[h] = 0
            if chunk:  # 只有真正下载分段才算"当前节点"，获取大小时各节点都会答复
                self.hits[h] = self.hits.get(h, 0) + 1
                self.st.host = h

    def _fail(self, u, err):
        h = host_of(u)
        with self.lock:
            n = self.fails[h] = self.fails.get(h, 0) + 1
            if n < HOST_FAIL_LIMIT or self.cool.get(h, 0) > time.time():
                return
            self.cool[h] = time.time() + HOST_COOLDOWN
            self.fails[h] = 0
        self.log(f"节点 {h} 连续失败 {n} 次，降权 {HOST_COOLDOWN} 秒：{err}")

    def _refresh(self):
        with self.lock:
            if time.time() - self.refreshed < REFRESH_MIN_INTERVAL:
                return
            self.refreshed = time.time()
        try:
            urls = self.st.refresh()
        except Exception as e:
            self.log("刷新链接失败:", e)
            return
        with self.lock:
            self.urls = urls
        self.log("链接已刷新")

    def host_stats(self):
        with self.lock:
            return dict(self.hits)

    def _probe_size(self, u, out):
        try:
            req = urllib.request.Request(u, headers={**self.api.base, "Range": "bytes=0-0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                out.put((u, int(r.headers["Content-Range"].split("/")[1]), None))
        except Exception as e:
            out.put((u, None, e))

    def total_size(self):
        """同时问所有节点，取最先返回的结果。逐个串行问的话，一个不通的节点会卡很久：
        urllib 的 timeout 按每个解析出的 IP 分别计算，CDN 域名常有好几个 IP。"""
        for round_ in range(2):
            pool = self._pool()
            out = queue.Queue()
            for u in pool:  # 守护线程：卡住的请求不会拖住程序退出
                threading.Thread(target=self._probe_size, args=(u, out), daemon=True).start()
            deadline = time.time() + 25
            size, ok = None, set()
            for _ in pool:
                try:
                    u, sz, err = out.get(timeout=max(deadline - time.time(), 0.01))
                except queue.Empty:
                    break
                if sz is not None:
                    self._ok(u, chunk=False)
                    ok.add(host_of(u))
                    if size is None:  # 拿到大小后再等一小会儿，看还有哪些节点是好的
                        size, deadline = sz, min(deadline, time.time() + 1.5)
                    continue
                self.log("获取大小失败:", host_of(u), err)
                self._fail(u, err)
                if isinstance(err, urllib.error.HTTPError) and err.code in (403, 404):
                    deadline = min(deadline, time.time() + 2)  # 签名多半过期了，不必等卡住的节点
            if size is not None:
                bad = {host_of(u) for u in pool} - ok
                if bad and ok:  # 没及时答复或出错的节点先降权，分段下载一开始就走好节点
                    with self.lock:
                        for h in bad:
                            self.cool[h] = time.time() + HOST_COOLDOWN
                    self.log(f"节点降权 {HOST_COOLDOWN} 秒（未及时响应或出错）:", ", ".join(sorted(bad)))
                return size
            if round_ == 0:
                self._refresh()  # 全部节点都失败，多半是链接过期
        raise RuntimeError("无法获取文件大小")

    def fetch(self, idx, size):
        start = idx * CHUNK
        end = min(start + CHUNK, size) - 1
        need = end - start + 1
        for attempt in range(30):
            if self.cancel and self.cancel.is_set():
                raise Cancelled()
            pool = self._pool()
            u = pool[attempt % len(pool)]  # 第一次尝试用最优节点，重试时轮换
            try:
                req = urllib.request.Request(u, headers={**self.api.base, "Range": f"bytes={start}-{end}"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                if len(data) != need:
                    raise IOError(f"short read {len(data)}/{need}")
                with self.lock:
                    with open(self.st.path, "r+b") as f:
                        f.seek(start)
                        f.write(data)
                    self.st.done += need
                    self.st.net += need
                self._ok(u)
                return idx
            except urllib.error.HTTPError as e:
                self._fail(u, e)
                if e.code in (403, 404):  # 签名链接过期，刷新
                    self._refresh()
                self._sleep(min(2 * (attempt + 1), 20))
            except (Cancelled, KeyboardInterrupt):
                raise
            except Exception as e:
                self._fail(u, e)
                self._sleep(min(1 + attempt, 15))
        raise RuntimeError(f"分段 {idx} 多次重试仍失败")

    def run(self):
        st = self.st
        st.status = "running"
        size = self.total_size()
        st.size = size
        n = (size + CHUNK - 1) // CHUNK
        done = set()
        if os.path.exists(self.state_path) and os.path.exists(st.path):
            try:
                with open(self.state_path) as f:
                    saved = json.load(f)
                if saved["size"] == size and os.path.getsize(st.path) == size:
                    done = set(saved["done"])
            except (ValueError, KeyError, TypeError):
                self.log("进度记录损坏，从头下载")

        def save():
            with self.lock:
                tmp = self.state_path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump({"size": size, "done": sorted(done)}, f)
                os.replace(tmp, self.state_path)

        if not done:
            with open(st.path, "wb") as f:
                f.truncate(size)
            save()  # 立刻留下进度记录，否则进程被强杀后，全 0 的文件会被当成已下完
        todo = [i for i in range(n) if i not in done]
        st.done = sum(min(CHUNK, size - i * CHUNK) for i in done)
        self.log(f"{st.label}: {size/1e6:.1f} MB，待下载 {len(todo)}/{n} 段")

        t0, b0, last = time.time(), st.done, time.time()
        ex = ThreadPoolExecutor(self.workers)
        try:
            futs = [ex.submit(self.fetch, i, size) for i in todo]
            for f in as_completed(futs):
                done.add(f.result())
                if time.time() - last > 15 or len(done) == n:
                    last = time.time()
                    save()
                    spd = (st.done - b0) / max(time.time() - t0, 1e-6)
                    eta = (size - st.done) / spd if spd else 0
                    self.log(f"  {st.label} {st.done/size*100:5.1f}%  {spd/1e6:.2f} MB/s  剩余约 {eta/60:.0f} 分钟  节点 {st.host}")
        except BaseException:
            ex.shutdown(wait=False, cancel_futures=True)
            save()
            raise
        ex.shutdown()
        os.remove(self.state_path)
        st.status = "done"


MAX_PATH = 259          # Windows 默认不支持长路径（不含结尾的 \0）
LONGEST_SUFFIX = ".video.m4s.state.json.tmp"
MAX_FOLDER_UNITS = 80   # 标题文件夹名的上限


def _units(s):
    """Windows 路径长度按 UTF-16 计：𝟰 这类花体字符算 2 个单位。"""
    return len(s.encode("utf-16-le")) // 2


def _clip(s, limit):
    out, n = [], 0
    for ch in s:
        n += _units(ch)
        if n > limit:
            break
        out.append(ch)
    return "".join(out).rstrip(" .")  # Windows 文件名不能以点或空格结尾


def output_layout(title, n_total, out_root):
    """多P视频放进以标题命名的子文件夹，每P一个文件；单P直接放在 out_root。
    名字过长时会截断，保证最长的临时文件路径也不超过 Windows 的 260 字符限制。"""
    multi = n_total > 1
    out_root = os.path.abspath(out_root)
    folder = os.path.join(out_root, _clip(safe(title), MAX_FOLDER_UNITS) or "video") if multi else out_root
    budget = MAX_PATH - _units(folder) - 1 - len(LONGEST_SUFFIX)
    if budget < 16:
        raise ValueError(f"保存目录路径太长，请换一个更短的目录：{out_root}")

    def name(page, part):
        return _clip(safe(f"P{page} {part}") if multi else safe(title), budget) or f"P{page}"

    return folder, name


def download_page(api, bvid, cid, folder, name, qn, codec="avc", ffmpeg=None, cancel=None, log=log,
                  on_streams=None, on_stage=None, workers=WORKERS, hosts=None):
    """下载并封装一个分P。返回 (mp4 路径, 实际清晰度名 或 None 表示已存在而跳过)。"""
    ffmpeg = ffmpeg or find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("找不到 ffmpeg，请先安装：winget install Gyan.FFmpeg")
    os.makedirs(folder, exist_ok=True)
    final = os.path.join(folder, name + ".mp4")
    if os.path.exists(final):
        log("已存在，跳过:", final)
        return final, None
    dash = playurl(api, bvid, cid, qn)["dash"]
    v, a = pick_streams(dash, qn, codec)
    qname = QN_NAME.get(v["id"], str(v["id"]))
    log(f"=== {name}  [{qname} {v['codecs']} {v['width']}x{v['height']}]  {max(1, min(int(workers), MAX_WORKERS))} 线程 ===")
    vid, vcodecs, aid = v["id"], v["codecs"], (a["id"] if a else None)

    def refresh(kind):
        def f():
            d = playurl(api, bvid, cid, qn)["dash"]
            if kind == "video":
                s = next(x for x in d["video"] if x["id"] == vid and x["codecs"] == vcodecs)
            else:
                s = next(x for x in all_audio(d) if x["id"] == aid)
            return mirrors(s, hosts)
        return f

    streams = [Stream("视频", os.path.join(folder, name + ".video.m4s"), refresh("video"))]
    if a:
        streams.append(Stream("音频", os.path.join(folder, name + ".audio.m4s"), refresh("audio")))
    for st in streams:  # 先把上次已下完的流标记好，让进度一开始就准确
        if os.path.exists(st.path) and not os.path.exists(st.path + ".state.json") and os.path.getsize(st.path) > 0:
            st.size = st.done = os.path.getsize(st.path)
            st.status = "done"
    if on_streams:
        on_streams(qname, streams)
    for st in streams:
        if st.status != "done":
            if on_stage:
                on_stage("下载" + st.label)
            Downloader(api, st, cancel, log, workers).run()
    if on_stage:
        on_stage("封装")
    tmp = os.path.join(folder, name + ".tmp.mp4")
    cmd = [ffmpeg, "-y", "-loglevel", "error"]
    for st in streams:
        cmd += ["-i", st.path]
    subprocess.run(cmd + ["-c", "copy", tmp], check=True, capture_output=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    os.replace(tmp, final)
    for st in streams:
        os.remove(st.path)
    log("完成 ->", final)
    return final, qname


# ---------- 字幕 ----------
# 字幕存成 <name>.<语言>.srt，和视频同名，播放器会自动加载。
# 临时文件是 <name>.<语言>.srt.tmp，语言代码限长 16，保证不比 LONGEST_SUFFIX 长
SUB_LAN_MAX = 16
SUB_MODES = ("auto", "all")


def list_subtitles(api, bvid, cid):
    """返回一个分P的字幕轨 [{lan, name, url, ai, translated}]。lan 以 ai- 开头的是 AI 字幕，
    translated 表示是 AI 从别的语言翻译来的。未登录时 B 站不返回任何字幕（包括 AI 字幕）。
    用带 WBI 签名的 wbi/v2：不签名的 /x/player/v2 偶尔会返回别的视频的 AI 字幕。"""
    d = api.get("https://api.bilibili.com/x/player/wbi/v2?" + api.wbi_query({"bvid": bvid, "cid": cid}))
    if d.get("code"):
        raise RuntimeError(f"获取字幕列表失败：{d.get('message')}")
    out = []
    for s in ((d.get("data") or {}).get("subtitle") or {}).get("subtitles") or []:
        url = s.get("subtitle_url") or ""
        if not url:  # AI 字幕还没生成好等情况
            continue
        lan = s.get("lan") or "und"
        ai = lan.startswith("ai-")
        out.append({"lan": lan, "name": s.get("lan_doc") or lan, "url": "https:" + url if url.startswith("//") else url,
                    "ai": ai, "translated": ai and s.get("ai_type") == 1})
    return out


def select_subtitles(subs, spec="auto"):
    """auto：全部人工字幕；没有人工字幕时取 AI 识别的原语言字幕（不含 AI 翻译）。all：全部。
    其他：逗号分隔的语言代码，如 zh,en。zh 能匹配 zh-CN、zh-Hans 和 ai-zh；写 ai-zh 则只匹配 AI 字幕。"""
    if spec == "all":
        return list(subs)
    if spec == "auto":
        return [s for s in subs if not s["ai"]] or [s for s in subs if s["ai"] and not s["translated"]]
    want = [w.strip().lower() for w in spec.split(",") if w.strip()]

    def hit(lan):
        lan = lan.lower()
        for w in want:
            base = lan if w.startswith("ai-") else lan.removeprefix("ai-")
            if base == w or base.startswith(w + "-"):
                return True
        return False

    return [s for s in subs if hit(s["lan"])]


def srt_time(t):
    ms = max(0, round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def to_srt(body):
    """B 站字幕 JSON 的 body（[{from, to, content}]）转成 SRT 文本。"""
    out, n = [], 0
    for c in body:
        text = str(c.get("content") or "").strip()
        if not text:
            continue
        n += 1
        out += [str(n), f"{srt_time(c.get('from', 0))} --> {srt_time(c.get('to', 0))}", text, ""]
    return "\n".join(out)


def sub_path(folder, name, lan):
    return os.path.join(folder, f"{name}.{safe(lan)[:SUB_LAN_MAX]}.srt")


def download_subtitles(api, bvid, cid, folder, name, spec="auto", duration=None, log=log):
    """下载一个分P的字幕。返回 (已保存的语言列表, 说明)；没有字幕不算错误，说明里会写原因。"""
    subs = list_subtitles(api, bvid, cid)
    chosen = select_subtitles(subs, spec)
    if not chosen:
        if subs:
            msg = "没有符合条件的字幕，可用的有：" + ", ".join(s["lan"] for s in subs)
        elif not api.sess:
            msg = "没有字幕：未登录时 B 站不返回字幕，请先登录"
        else:
            msg = "B 站没有给这个视频提供字幕（人工和 AI 字幕都没有）"
        log(f"{name}: {msg}")
        return [], msg
    os.makedirs(folder, exist_ok=True)

    def fetch(s):
        req = urllib.request.Request(s["url"], headers=api.base)
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r).get("body") or []

    todo = [s for s in chosen if not os.path.exists(sub_path(folder, name, s["lan"]))]
    with ThreadPoolExecutor(4) as ex:  # 字幕服务器单个请求常要一两秒，多条字幕一起取
        bodies = dict(zip((s["lan"] for s in todo), ex.map(fetch, todo)))
    saved, skipped = [], []
    for s in chosen:
        path = sub_path(folder, name, s["lan"])
        if s["lan"] in bodies:
            body = bodies[s["lan"]]
            last = max((c.get("to", 0) for c in body), default=0)
            if duration and last > duration + 30:  # 万一接口又串台，别把别的视频的字幕存下来
                skipped.append(s["lan"])
                log(f"{name}: 字幕 {s['lan']} 比视频长很多（{last:.0f}s > {duration}s），疑似别的视频的字幕，已跳过")
                continue
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8-sig") as f:  # 带 BOM，老一些的 Windows 播放器才能认出 UTF-8
                f.write(to_srt(body))
            os.replace(tmp, path)
        saved.append(s["lan"])
    msg = "字幕：" + (", ".join(saved) or "无") + (f"（跳过 {', '.join(skipped)}）" if skipped else "")
    log(f"{name}: {msg}")
    return saved, msg


# ---------- 弹幕 ----------
# 弹幕存成 <name>.danmaku.ass，播放器会和字幕一样自动加载。原始数据取自 protobuf 分段接口（每段 6 分钟，
# 和 B 站客户端离线缓存里的 dm1、dm2… 是同样的数据），转 ASS 交给 biliass（pip install biliass，GPL-3.0）。
DM_SEG = 360
# 样式接近网页版：舞台 1920x1080 下 38px 约等于 720p 播放器里的 25px；只占画面上方 3/4，不挡底部字幕
DM_STAGE = (1920, 1080)
DM_STYLE = {"font_face": "Microsoft YaHei", "font_size": 38, "text_opacity": 0.8, "duration_marquee": 10.0,
            "duration_still": 5.0, "display_region_ratio": 0.75, "reduce_comments": False}


def danmaku_available():
    """返回 (能否生成弹幕, 不能时的原因)。biliass 是可选依赖，没装时只是不能下弹幕。"""
    try:
        import biliass  # noqa: F401
        return True, ""
    except ImportError:
        return False, "生成弹幕需要 biliass（Python 3.11+）：python -m pip install biliass"


def fetch_danmaku(api, cid, duration):
    """返回一个分P的全部弹幕分段（protobuf bytes 列表，空段已去掉）。"""
    def seg(i):
        try:
            q = api.wbi_query({"type": 1, "oid": cid, "segment_index": i})
            return api.get_bytes("https://api.bilibili.com/x/v2/dm/wbi/web/seg.so?" + q)
        except urllib.error.HTTPError:  # 签名版不可用时退回旧接口，返回的数据一样
            return api.get_bytes(f"https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&segment_index={i}")

    n = max(1, -(-int(duration or 0) // DM_SEG))
    with ThreadPoolExecutor(4) as ex:
        return [b for b in ex.map(seg, range(1, n + 1)) if b]


def dm_path(folder, name):
    return os.path.join(folder, name + ".danmaku.ass")


def download_danmaku(api, cid, folder, name, duration, log=log):
    """下载一个分P的弹幕并转成 ASS。返回 (路径 或 None, 说明)；没有弹幕或没装 biliass 不算错误。"""
    ok, why = danmaku_available()
    if not ok:
        log(f"{name}: {why}")
        return None, why
    path = dm_path(folder, name)
    if os.path.exists(path):
        log(f"{name}: 弹幕已存在，跳过")
        return path, "弹幕：已存在"
    segs = fetch_danmaku(api, cid, duration)
    if not segs:
        log(f"{name}: 没有弹幕")
        return None, "没有弹幕"
    import biliass
    ass = biliass.convert_to_ass(segs, *DM_STAGE, input_format="protobuf", **DM_STYLE)
    n = ass.count("\nDialogue:")
    os.makedirs(folder, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8-sig") as f:
        f.write(ass)
    os.replace(tmp, path)
    msg = f"弹幕：{n} 条"
    log(f"{name}: {msg}")
    return path, msg


def cmd_info(api, bvid, title, pages):
    q, audio_kbps = probe_bitrates(api, bvid, pages)
    total_dur = sum(p[3] for p in pages)
    approx = "约" if len(pages) > 8 else ""
    print(f"\n{title}  （{len(pages)} 个分P，总时长 {total_dur/3600:.1f} 小时）")
    print(f"{'清晰度':<10}{'编码':<7}{'分辨率':<11}{'视频+音频':>10}")
    for qn, (name, codec, res, kbps) in sorted(q.items(), reverse=True):
        size = (kbps + audio_kbps) * 1000 * total_dur / 8
        print(f"{name:<10}{codec:<7}{res:<11}{approx:>2}{size/1e9:>7.2f} GB")
    page = pages[0][0]
    try:
        subs = list_subtitles(api, bvid, pages[0][2])
    except Exception as e:
        print(f"\nP{page} 的字幕：获取失败（{e}）")
        return
    print(f"\nP{page} 的字幕：" + ("" if subs else ("无（未登录时 B 站不返回字幕）" if not api.sess else "无")))
    for s in subs:
        kind = "AI 翻译" if s["translated"] else "AI 识别" if s["ai"] else "人工"
        print(f"  {s['lan']:<10}{kind:<8}{s['name']}")


def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="bilidl", description="Bilibili 视频下载器")
    ap.add_argument("target", nargs="?", help="视频链接 / BV 号 / b23.tv 短链")
    ap.add_argument("-q", "--quality", default="720", choices=QUALITY, help="清晰度（默认 720）")
    ap.add_argument("-p", "--pages", help="分P，如 1 或 1,3-4；默认全部（链接带 ?p=N 时只下该P）")
    ap.add_argument("-o", "--out", default=os.getcwd(), help="保存目录（默认当前目录）")
    ap.add_argument("-j", "--threads", type=int, default=WORKERS,
                    help=f"并发线程数（默认 {WORKERS}，最多 {MAX_WORKERS}；CDN 按连接限速，线程越多越快，但太多容易被风控）")
    ap.add_argument("--codec", default="avc", choices=CODEC_PREF, help="偏好编码（默认 avc，兼容性最好）")
    ap.add_argument("--sub", nargs="?", const="auto", metavar="auto|all|语言",
                    help="同时下载字幕（存成同名 .srt，需要登录）。auto（默认）：人工字幕，没有时用 AI 识别字幕；"
                         "all：全部，包括 AI 翻译；也可以写语言代码，如 zh,en 或 ai-zh")
    ap.add_argument("--danmaku", action="store_true",
                    help="同时下载弹幕（存成同名 .danmaku.ass，需要 python -m pip install biliass）")
    ap.add_argument("--sub-only", action="store_true",
                    help="只下载字幕/弹幕，不下载视频（不需要 ffmpeg）；没写 --danmaku 时默认 --sub auto")
    ap.add_argument("--info", action="store_true", help="只显示各清晰度大小和字幕，不下载")
    ap.add_argument("--set-cookie", metavar="SESSDATA", help="保存登录 cookie 的 SESSDATA 值")
    args = ap.parse_args()
    if not 1 <= args.threads <= MAX_WORKERS:
        ap.error(f"--threads 需要在 1~{MAX_WORKERS} 之间")

    if args.set_cookie:
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            f.write(args.set_cookie.strip())
        print("已保存到", COOKIE_FILE)
        if not args.target:
            return
    if not args.target:
        ap.print_help()
        return

    api = Api()
    nav = api.nav()
    log("登录状态:", ("已登录" + ("（大会员）" if nav["vip"] else "")) if nav["login"] else "未登录（最高 480P，用 --set-cookie 登录）")
    bvid, url_page = resolve_target(args.target)
    title, owner, pages = video_meta(api, bvid)
    log(f"{title}  UP: {owner}  共 {len(pages)} P")
    n_total = len(pages)
    sel = parse_pages(args.pages or (str(url_page) if url_page else None), n_total)
    pages = [p for p in pages if p[0] in sel]
    if args.info:
        cmd_info(api, bvid, title, pages)
        return
    folder, name = output_layout(title, n_total, args.out)
    sub = args.sub or ("auto" if args.sub_only and not args.danmaku else None)
    if args.danmaku and not danmaku_available()[0]:
        log(danmaku_available()[1])
    for page, part, cid, dur in pages:
        if sub:
            try:
                download_subtitles(api, bvid, cid, folder, name(page, part), sub, dur)
            except Exception as e:  # 字幕失败不影响下载视频
                log(f"P{page} 字幕下载失败:", e)
        if args.danmaku:
            try:
                download_danmaku(api, cid, folder, name(page, part), dur)
            except Exception as e:  # 弹幕失败也不影响下载视频
                log(f"P{page} 弹幕下载失败:", e)
        if not args.sub_only:
            download_page(api, bvid, cid, folder, name(page, part), QUALITY[args.quality], args.codec, workers=args.threads)
    log("全部完成:", folder)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已中断，下次运行同样的命令会断点续传。")
    except ValueError as e:
        sys.exit(str(e))
