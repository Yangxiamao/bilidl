"""bilidl-web - bilidl 的本地网页界面

只监听 127.0.0.1:8765。页面里嵌入启动时生成的随机 token，所有 /api/* 请求必须带 X-Token 头，
并校验 Host 头，防止其他网页（包括 DNS rebinding）调用本地接口。

用法: bilidl-web [--no-browser]
"""
import collections, hmac, itertools, json, os, queue, secrets, socket, subprocess, sys, threading, time
import urllib.error, urllib.parse, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOME)  # python -I 不会把脚本目录加入 sys.path
import bilidl
import bilidl_play

PORT = 8765
HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
TOKEN = secrets.token_urlsafe(24)
CONFIG_FILE = os.path.join(HOME, "config.json")
PAGE_FILE = os.path.join(HOME, "bilidl_web.html")
FFMPEG = bilidl.find_ffmpeg()
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# 后台运行时 sys.executable 是 pythonw.exe；选择文件夹的子进程要靠 stdout 回传路径，用同目录的 python.exe 更稳
_py = os.path.join(os.path.dirname(sys.executable), "python.exe")
CONSOLE_PYTHON = _py if os.path.exists(_py) else sys.executable

PICKER = r"""
import sys, tkinter
from tkinter import filedialog
root = tkinter.Tk()
root.withdraw()
root.attributes("-topmost", True)
root.update()
d = filedialog.askdirectory(parent=root, initialdir=sys.argv[1] or None, title="选择保存目录", mustexist=False)
sys.stdout.buffer.write((d or "").encode("utf-8"))
"""

LOCK = threading.RLock()
JOBS = {}           # id -> Job（按创建顺序）
INFO = {}           # bvid -> 解析结果缓存
PICKED = set()      # 用户通过对话框选过的目录，允许 /api/open
QUEUE = queue.Queue()
PICK_LOCK = threading.Lock()
SUB_MODES = ("off",) + bilidl.SUB_MODES
PLAYER = None       # bilidl_play.Cache，在 main() 里创建


class UserError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


# ---------- 配置与 Api ----------

def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(**kw):
    cfg = {**load_config(), **kw}
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CONFIG_FILE)


def default_dir():
    d = load_config().get("last_dir")
    if d and os.path.isdir(d):
        return d
    downloads = os.path.join(os.path.expanduser("~"), "Downloads")
    return downloads if os.path.isdir(downloads) else os.path.expanduser("~")


def default_subs():
    m = load_config().get("subs")
    return m if m in SUB_MODES else "auto"


def default_danmaku():
    return load_config().get("danmaku", True) is not False


def default_threads():
    t = load_config().get("threads")
    return t if isinstance(t, int) and 1 <= t <= bilidl.MAX_WORKERS else bilidl.WORKERS


def default_qn():
    q = load_config().get("qn")
    return q if q in bilidl.QN_NAME else 64


_api = None
_api_lock = threading.Lock()


def get_api():
    """Api() 初始化要联网取游客 buvid，失败时不影响服务启动，下次用到再试。"""
    global _api
    with _api_lock:
        if _api is None:
            try:
                _api = bilidl.Api()
            except Exception as e:
                raise UserError(f"连接 B 站 API 失败：{e}", 502)
        return _api


def friendly(e):
    if isinstance(e, urllib.error.HTTPError) and e.code == 412:
        return "B 站风控拦截（412），请稍后再试"
    if isinstance(e, subprocess.CalledProcessError):
        err = (e.stderr or b"").decode("utf-8", "replace").strip()
        return "ffmpeg 封装失败" + (f"：{err[-300:]}" if err else "")
    return f"{type(e).__name__}: {e}"


def norm(p):
    return os.path.normcase(os.path.abspath(p))


# ---------- 任务 ----------

class PageTask:
    def __init__(self, page, part, cid, dur, name, est_v, est_a):
        self.page, self.part, self.cid, self.dur, self.name = page, part, cid, dur, name
        self.est_v, self.est_a = est_v, est_a
        self.state = "queued"  # queued / running / done / exists / failed / cancelled / skipped（用户单独跳过）
        self.cancel = threading.Event()  # 只停这一个分P；取消整个任务时也会设置正在下载的分P的
        self.stage, self.qname, self.error, self.path = "", None, "", None
        self.streams = []
        self.final_size = 0
        self.subs, self.sub_msg = [], ""  # 已保存的字幕语言；字幕的结果说明（没有字幕的原因等）
        self.dm_file, self.dm_msg = None, ""  # 弹幕文件；弹幕的结果说明

    def on_streams(self, qname, streams):
        self.qname = qname
        for new in streams:  # 重试时先沿用上次的进度，避免进度条掉回 0 再跳上去
            old = next((o for o in self.streams if o.label == new.label), None)
            if old and new.status != "done" and not new.done:
                new.size, new.done = old.size, old.done
        self.streams = streams

    def progress(self):
        if self.state in ("done", "exists"):
            return self.final_size, self.final_size
        est = {"视频": self.est_v, "音频": self.est_a}
        if not self.streams:
            return 0, self.est_v + self.est_a
        done = sum(st.done for st in self.streams)
        total = sum(st.size or est.get(st.label, 0) for st in self.streams)
        return done, max(total, done)

    def snapshot(self):
        done, total = self.progress()
        return {"page": self.page, "part": self.part, "dur": self.dur, "state": self.state, "stage": self.stage,
                "qname": self.qname, "error": self.error, "done": done, "total": total,
                "cancelling": self.state == "running" and self.cancel.is_set(),
                "subs": self.subs, "sub_msg": self.sub_msg, "dm": bool(self.dm_file), "dm_msg": self.dm_msg}


class Job:
    _ids = itertools.count(1)

    def __init__(self, bvid, title, folder, qn, pages, workers, subs="off", sub_only=False, danmaku=False):
        self.id = next(Job._ids)
        self.bvid, self.title, self.folder, self.qn, self.pages = bvid, title, folder, qn, pages
        self.workers = workers
        self.subs, self.sub_only, self.danmaku = subs, sub_only, danmaku
        self.status = "queued"  # queued / running / done / partial / failed / cancelled
        self.cancel = threading.Event()
        self.logs = collections.deque(maxlen=50)
        self.samples = collections.deque()
        self.speed = 0.0
        self.error = ""

    def log(self, *a):
        line = " ".join(map(str, a))
        self.logs.append(time.strftime("%H:%M:%S ") + line)
        bilidl.log(f"[任务{self.id}]", line)

    def net_bytes(self):
        return sum(st.net for p in self.pages for st in p.streams)

    def snapshot(self):
        pages = [p.snapshot() for p in self.pages]
        kept = [p for p in pages if p["state"] != "skipped"]  # 跳过的分P不算进总进度
        done = sum(p["done"] for p in kept)
        total = sum(p["total"] for p in kept)
        speed = self.speed if self.status == "running" else 0
        node = next((st.host for p in self.pages if p.state == "running" for st in p.streams
                     if st.status == "running" and st.host), "")
        return {"id": self.id, "bvid": self.bvid, "title": self.title, "folder": self.folder,
                "quality": bilidl.QN_NAME.get(self.qn, str(self.qn)), "status": self.status,
                "workers": self.workers, "node": node, "subs": self.subs, "sub_only": self.sub_only,
                "danmaku": self.danmaku,
                "cancelling": self.status == "running" and self.cancel.is_set(),
                "done": done, "total": total, "speed": speed,
                "eta": (total - done) / speed if speed > 1 else None,
                "log": self.logs[-1] if self.logs else "", "error": self.error, "pages": pages}


def finish_status(job):
    states = [p.state for p in job.pages if p.state != "skipped"]
    if not states:  # 全部跳过
        return "cancelled"
    if all(s in ("done", "exists") for s in states):
        return "done"
    if "cancelled" in states:
        return "cancelled"
    if all(s == "failed" for s in states):
        return "failed"
    return "partial"


def run_job(job):
    try:
        api = get_api()
    except UserError as e:
        job.error = str(e)
        for p in job.pages:
            if p.state == "queued":
                p.state, p.error = "failed", str(e)
        return
    while True:
        # 每次重新找第一个排队的分P：下载中途跳过、恢复的分P都能照顾到。
        # 没有排队的分P时在锁里直接结束任务，避免和「恢复」抢着改状态
        with LOCK:
            if job.cancel.is_set():
                for q in job.pages:
                    if q.state == "queued":
                        q.state = "cancelled"
            p = next((q for q in job.pages if q.state == "queued"), None)
            if p is None:
                job.status = finish_status(job)
                return
            p.state, p.stage, p.error = "running", "准备", ""
            p.cancel = threading.Event()

        def on_stage(s, p=p):
            p.stage = s

        # 字幕、弹幕失败都不影响下载视频；只下字幕/弹幕时算这个分P失败，可以重试
        errors = []
        if job.subs != "off":
            p.stage = "下载字幕"
            try:
                p.subs, p.sub_msg = bilidl.download_subtitles(api, job.bvid, p.cid, job.folder, p.name, job.subs,
                                                              p.dur, log=job.log)
            except Exception as e:
                p.subs, p.sub_msg = [], f"字幕下载失败：{friendly(e)}"
                job.log(f"P{p.page} {p.sub_msg}")
                errors.append(p.sub_msg)
        if job.danmaku:
            p.stage = "下载弹幕"
            try:
                p.dm_file, p.dm_msg = bilidl.download_danmaku(api, p.cid, job.folder, p.name, p.dur, log=job.log)
            except Exception as e:
                p.dm_file, p.dm_msg = None, f"弹幕下载失败：{friendly(e)}"
                job.log(f"P{p.page} {p.dm_msg}")
                errors.append(p.dm_msg)
        if p.cancel.is_set():  # 下字幕/弹幕时点了跳过或取消
            p.state, p.stage = "cancelled" if job.cancel.is_set() else "skipped", ""
            continue
        if job.sub_only:
            if errors:
                p.state, p.stage, p.error = "failed", "", "；".join(errors)
                continue
            p.final_size = sum(os.path.getsize(bilidl.sub_path(job.folder, p.name, lan)) for lan in p.subs)
            if p.dm_file:
                p.final_size += os.path.getsize(p.dm_file)
            p.state, p.stage = "done", ""
            continue
        try:
            path, qname = bilidl.download_page(api, job.bvid, p.cid, job.folder, p.name, job.qn, ffmpeg=FFMPEG,
                                               cancel=p.cancel, log=job.log, on_streams=p.on_streams,
                                               on_stage=on_stage, workers=job.workers)
            p.path, p.final_size = path, os.path.getsize(path)
            p.state = "exists" if qname is None else "done"
        except bilidl.Cancelled:
            if job.cancel.is_set():
                p.state = "cancelled"
                job.log(f"P{p.page} 已取消，下次重试会断点续传")
            else:
                p.state = "skipped"
                job.log(f"P{p.page} 已跳过，恢复后会断点续传")
        except Exception as e:
            p.state, p.error = "failed", friendly(e)
            job.log(f"P{p.page} 失败：{p.error}")
        p.stage = ""


def worker():
    while True:
        job = QUEUE.get()
        with LOCK:
            if job.status != "queued" or job.id not in JOBS:
                continue  # 排队时已取消/移除，或是重试留下的重复项
            job.status = "running"
            job.samples.clear()
        try:
            run_job(job)
        except Exception as e:  # 兜底，保证工作线程不会死
            job.error = friendly(e)
        with LOCK:
            if job.status == "running":  # 正常结束时 run_job 已经设好了
                job.status = finish_status(job)
        job.log("任务结束：", job.status)


def sampler():
    """每秒记录一次实际网络字节数，用最近约 5 秒的增量算速度。"""
    while True:
        now = time.time()
        with LOCK:
            jobs = list(JOBS.values())
        for j in jobs:
            if j.status != "running":
                continue
            net = j.net_bytes()
            j.samples.append((now, net))
            while len(j.samples) > 2 and now - j.samples[0][0] > 5.5:
                j.samples.popleft()
            t0, b0 = j.samples[0]
            j.speed = max(net - b0, 0) / (now - t0) if now - t0 >= 0.9 else 0.0
        time.sleep(1)


# ---------- 接口 ----------

def api_status(_):
    out = {"default_dir": default_dir(), "threads": default_threads(), "max_threads": bilidl.MAX_WORKERS,
           "qn": default_qn(), "subs": default_subs(), "danmaku": default_danmaku(),
           "danmaku_ok": bilidl.danmaku_available()[0], "danmaku_why": bilidl.danmaku_available()[1],
           "ffmpeg": bool(FFMPEG), "login": None, "vip": False, "uname": ""}
    try:
        out.update(get_api().nav())
    except Exception as e:
        out["error"] = e.args[0] if isinstance(e, UserError) else friendly(e)
    return out


def api_info(body):
    url = str(body.get("url") or "").strip()
    if not url:
        raise UserError("请输入视频链接或 BV 号")
    try:
        bvid, url_page = bilidl.resolve_target(url)
    except ValueError as e:
        raise UserError(str(e))
    except Exception as e:
        raise UserError(f"解析短链失败：{friendly(e)}", 502)
    with LOCK:
        cached = INFO.get(bvid)
    if not cached:
        api = get_api()
        try:
            title, owner, pages = bilidl.video_meta(api, bvid)
            q, audio_kbps = bilidl.probe_bitrates(api, bvid, pages)
        except Exception as e:
            raise UserError(f"获取视频信息失败：{friendly(e)}", 502)
        sub_page = next((p for p in pages if p[0] == url_page), pages[0])
        try:  # 只看一个分P的字幕，给用户参考；下载时每个分P再单独查
            subs = [{"lan": s["lan"], "name": s["name"], "ai": s["ai"], "translated": s["translated"]}
                    for s in bilidl.list_subtitles(api, bvid, sub_page[2])]
        except Exception as e:
            bilidl.log("获取字幕列表失败:", friendly(e))
            subs = None
        cached = {"bvid": bvid, "title": title, "owner": owner,
                  "pages": [{"page": pg, "part": part, "cid": cid, "dur": dur} for pg, part, cid, dur in pages],
                  "qualities": [{"qn": qn, "name": n, "codec": c, "res": r, "kbps": k}
                                for qn, (n, c, r, k) in sorted(q.items(), reverse=True)],
                  "audio_kbps": audio_kbps, "subs": subs, "sub_page": sub_page[0], "login": bool(api.sess)}
        with LOCK:
            INFO[bvid] = cached
    return {**cached, "url_page": url_page}


def api_download(body):
    bvid = str(body.get("bvid") or "")
    with LOCK:
        info = INFO.get(bvid)
    if not info:
        raise UserError("请先解析视频")
    try:
        qn = int(body.get("qn"))
        sel = {int(x) for x in body.get("pages") or []}
    except (TypeError, ValueError):
        raise UserError("参数错误")
    if qn not in bilidl.QN_NAME:
        raise UserError("清晰度无效")
    try:
        workers = int(body.get("threads") or default_threads())
    except (TypeError, ValueError):
        raise UserError("线程数无效")
    if not 1 <= workers <= bilidl.MAX_WORKERS:
        raise UserError(f"线程数需要在 1~{bilidl.MAX_WORKERS} 之间")
    subs = str(body.get("subs") or "off")
    sub_only = bool(body.get("sub_only"))
    danmaku = bool(body.get("danmaku"))
    if subs not in SUB_MODES:
        raise UserError("字幕选项无效")
    if danmaku and not bilidl.danmaku_available()[0]:
        raise UserError(bilidl.danmaku_available()[1])
    if sub_only and subs == "off" and not danmaku:
        raise UserError("只下载字幕/弹幕时，字幕和弹幕至少要选一个")
    pages = [p for p in info["pages"] if p["page"] in sel]
    if not pages:
        raise UserError("请至少选择一个分P")
    out_dir = str(body.get("out_dir") or "").strip().strip('"')
    if not out_dir or not os.path.isabs(out_dir):
        raise UserError("保存目录需要是完整路径，例如 D:\\Videos")
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        raise UserError(f"无法创建保存目录：{e}")
    out_dir = os.path.abspath(out_dir)
    try:
        folder, name_fn = bilidl.output_layout(info["title"], len(info["pages"]), out_dir)
    except ValueError as e:
        raise UserError(str(e))

    # 估算大小：与 pick_streams 一样，所选清晰度不可用时取不超过它的最高清晰度
    rates = {q["qn"]: q["kbps"] for q in info["qualities"]}
    if rates:
        eff = max([x for x in rates if x <= qn] or [min(rates)])
        vk = rates[eff]
    else:
        vk = 0
    ak = info["audio_kbps"]
    if sub_only:
        vk = ak = 0
    tasks = [PageTask(p["page"], p["part"], p["cid"], p["dur"], name_fn(p["page"], p["part"]),
                      vk * 125 * p["dur"], ak * 125 * p["dur"]) for p in pages]

    with LOCK:
        check_busy(folder, tasks)
        job = Job(bvid, info["title"], folder, qn, tasks, workers, subs, sub_only, danmaku)
        JOBS[job.id] = job
    dm_cfg = {"danmaku": danmaku} if bilidl.danmaku_available()[0] else {}  # 没装 biliass 时别把「关」记下来
    save_config(last_dir=out_dir, threads=workers, subs=subs, **dm_cfg, **({} if sub_only else {"qn": qn}))
    extras = ("" if subs == "off" else "  含字幕") + ("  含弹幕" if danmaku else "")
    what = ("只下字幕/弹幕" + extras) if sub_only else f"{bilidl.QN_NAME[qn]}  {workers} 线程" + extras
    job.log(f"加入队列：{info['title']}  {len(tasks)} 个分P  {what}  -> {folder}")
    QUEUE.put(job)
    return {"id": job.id}


def check_busy(folder, tasks, me=None):
    """同一个文件不能同时在两个未结束的任务里。调用时要持有 LOCK。"""
    targets = {norm(os.path.join(folder, t.name)) for t in tasks}
    for j in JOBS.values():
        if j is not me and j.status in ("queued", "running") and any(
                norm(os.path.join(j.folder, p.name)) in targets for p in j.pages if p.state in ("queued", "running")):
            raise UserError(f"任务 #{j.id} 里已经有相同的文件在排队或下载")


def find_job(body):
    try:
        jid = int(body.get("id"))
    except (TypeError, ValueError):
        raise UserError("参数错误")
    with LOCK:
        job = JOBS.get(jid)
    if not job:
        raise UserError("任务不存在", 404)
    return job


def api_jobs(_):
    with LOCK:
        jobs = list(JOBS.values())
    return {"jobs": [j.snapshot() for j in jobs]}


def api_cancel(body):
    job = find_job(body)
    with LOCK:
        if job.status == "queued":
            job.status = "cancelled"
            for p in job.pages:
                if p.state == "queued":
                    p.state = "cancelled"
        elif job.status == "running":
            job.cancel.set()
            for p in job.pages:
                if p.state == "running":
                    p.cancel.set()
            job.log("正在取消…")
        else:
            raise UserError("任务已结束")
    return {"ok": True}


def find_page(body):
    job = find_job(body)
    try:
        n = int(body.get("page"))
    except (TypeError, ValueError):
        raise UserError("参数错误")
    p = next((p for p in job.pages if p.page == n), None)
    if not p:
        raise UserError("这个任务里没有这一P", 404)
    return job, p


def api_skip(body):
    """跳过一个分P：排队的直接标记，正在下载的打断（已下的部分留着，恢复后续传）。"""
    job, p = find_page(body)
    with LOCK:
        if p.state == "queued":
            p.state = "skipped"
            if job.status == "queued" and not any(q.state == "queued" for q in job.pages):
                job.status = finish_status(job)  # 排队的任务一P都不剩了，直接结束
        elif p.state == "running":
            if p.cancel.is_set():
                raise UserError("正在跳过这一P")
            p.cancel.set()
        else:
            raise UserError("这一P已经结束，不能跳过")
    job.log(f"跳过 P{p.page}")
    return {"ok": True}


def api_unskip(body):
    """恢复跳过的分P。任务还没结束就排回队里；已经结束的任务重新排队，只下这一P。"""
    job, p = find_page(body)
    with LOCK:
        if p.state != "skipped":
            raise UserError("这一P没有被跳过")
        check_busy(job.folder, [p], me=job)
        p.state, p.error = "queued", ""
        requeue = job.status not in ("queued", "running")
        if requeue:
            job.cancel = threading.Event()
            job.status, job.error = "queued", ""
            job.samples.clear()
    job.log(f"恢复 P{p.page}" + ("，重新加入队列" if requeue else ""))
    if requeue:
        QUEUE.put(job)
    return {"ok": True}


def api_retry(body):
    job = find_job(body)
    with LOCK:
        if job.status not in ("failed", "partial", "cancelled"):
            raise UserError("只有失败或已取消的任务可以重试")
        for p in job.pages:
            if p.state in ("failed", "cancelled"):
                p.state, p.error = "queued", ""
        job.cancel = threading.Event()
        job.status, job.error = "queued", ""
        job.samples.clear()
    job.log("重新加入队列")
    QUEUE.put(job)
    return {"ok": True}


def api_remove(body):
    job = find_job(body)
    with LOCK:
        if job.status == "running":
            raise UserError("任务正在下载，请先取消")
        if job.status == "queued":
            job.status = "cancelled"
        JOBS.pop(job.id, None)
    return {"ok": True}


def api_pick_folder(body):
    initial = str(body.get("initial") or "")
    if not os.path.isdir(initial):
        initial = default_dir()
    if not PICK_LOCK.acquire(blocking=False):
        raise UserError("已经打开了一个选择窗口")
    try:
        r = subprocess.run([CONSOLE_PYTHON, "-I", "-c", PICKER, initial], capture_output=True,
                           creationflags=NO_WINDOW)
    finally:
        PICK_LOCK.release()
    path = r.stdout.decode("utf-8", "replace").strip()
    if not path:
        return {"path": ""}
    path = os.path.normpath(path)
    with LOCK:
        PICKED.add(norm(path))
    save_config(last_dir=path)
    return {"path": path}


def api_open(body):
    path = str(body.get("path") or "").strip().strip('"')
    if not path:
        raise UserError("路径为空")
    with LOCK:
        allowed = {norm(j.folder) for j in JOBS.values()} | PICKED
    allowed.add(norm(default_dir()))
    if norm(path) not in allowed:
        raise UserError("只能打开任务的保存目录，或用「浏览…」选过的目录", 403)
    if not os.path.isdir(path):
        raise UserError("目录还不存在（开始下载后才会创建）")
    os.startfile(os.path.normpath(path))
    return {"ok": True}


def api_cookie(body):
    sess = str(body.get("sessdata") or "").strip()
    if sess.lower().startswith("sessdata="):
        sess = sess[9:]
    if any(c in sess for c in ";\r\n \t"):
        raise UserError("SESSDATA 格式不对：只需要填值本身，不含分号和空格")
    with open(bilidl.COOKIE_FILE, "w", encoding="utf-8") as f:
        f.write(sess)
    api = get_api()
    api.sess = sess
    with LOCK:
        INFO.clear()  # 可用清晰度和登录状态有关，缓存作废
    try:
        return api.nav()
    except Exception as e:
        raise UserError(f"已保存，但检查登录状态失败：{friendly(e)}", 502)


def api_sync_cookie(body):
    """Chrome 插件每次解析前把浏览器里的 SESSDATA 发过来；没变就什么都不做，变了才保存。"""
    sess = str(body.get("sessdata") or "").strip()
    if not sess:
        raise UserError("SESSDATA 为空")
    if hmac.compare_digest(sess.encode(), (get_api().sess or "").encode()):
        return {"changed": False}
    out = api_cookie({"sessdata": sess})
    bilidl.log("已从 Chrome 插件同步登录 cookie")
    return {"changed": True, **out}


def api_play_stats(_):
    if PLAYER is None:
        raise UserError("播放加速没有启动", 503)
    return PLAYER.stats()


GET_ROUTES = {"/api/status": api_status, "/api/jobs": api_jobs, "/api/play_stats": api_play_stats}
POST_ROUTES = {"/api/info": api_info, "/api/download": api_download, "/api/cancel": api_cancel,
               "/api/retry": api_retry, "/api/skip": api_skip, "/api/unskip": api_unskip,
               "/api/remove": api_remove, "/api/pick_folder": api_pick_folder,
               "/api/open": api_open, "/api/cookie": api_cookie, "/api/sync_cookie": api_sync_cookie}

CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; "
       "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


class Handler(BaseHTTPRequestHandler):
    server_version = "bilidl-web"

    def log_message(self, *a):  # 不记录逐条请求（轮询太多，也避免任何请求内容进日志）
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self, need_token):
        if self.headers.get("Host") not in HOSTS:
            self._send(403, {"error": "Host 不允许"})
            return False
        if need_token and not hmac.compare_digest(self.headers.get("X-Token", ""), TOKEN):
            self._send(403, {"error": "token 无效，请刷新页面"})
            return False
        return True

    def _call(self, fn, body):
        try:
            self._send(200, fn(body))
        except UserError as e:
            self._send(e.code, {"error": str(e)})
        except Exception as e:
            bilidl.log("接口出错:", self.path, friendly(e))
            self._send(500, {"error": friendly(e)})

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/":
            if not self._allowed(False):
                return
            with open(PAGE_FILE, encoding="utf-8") as f:
                html = f.read().replace("__TOKEN__", TOKEN)
            self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/api/token":
            # 给 Chrome 插件取 token。普通网页跨域读不到响应（没有 CORS 头），这里再按 Origin 挡一层
            origin = self.headers.get("Origin")
            if origin and not origin.startswith("chrome-extension://"):
                self._send(403, {"error": "Origin 不允许"})
            elif self._allowed(False):
                self._send(200, {"token": TOKEN})
        elif path in GET_ROUTES:
            if self._allowed(True):
                self._call(GET_ROUTES[path], {})
        elif path.startswith("/play/"):
            if self._allowed(False):
                self._play()
        else:
            self._send(404, {"error": "not found"})

    def _play_cors(self):
        """在线播放的 CORS 头。只给 B 站页面（以及跨源重定向后变成 null 的 Origin）读响应。"""
        origin = self.headers.get("Origin")
        if not origin:
            return {}
        if not bilidl_play.ORIGIN_OK.match(origin):
            return None
        return {"Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Content-Range, Content-Length",
                "Vary": "Origin"}

    def do_OPTIONS(self):
        if not urllib.parse.urlsplit(self.path).path.startswith("/play/"):
            self._send(404, {"error": "not found"})
            return
        cors = self._play_cors()
        if not cors:
            self._send(403, {"error": "Origin 不允许"})
            return
        if not self._allowed(False):
            return
        self.send_response(204)
        for k, v in {**cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Range",
                     "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600",
                     "Content-Length": "0"}.items():
            self.send_header(k, v)
        self.end_headers()

    def _play(self):
        """/play/ping：扩展用来确认页面能访问本机服务；/play/<原始 m4s 链接>：经缓存转发。"""
        cors = self._play_cors()
        if cors is None:
            self._send(403, {"error": "Origin 不允许"})
            return
        target = self.path[len("/play/"):]
        try:
            if PLAYER is None:
                raise bilidl_play.PlayError(503, "播放加速没有启动")
            if target == "ping":
                self.send_response(204)
                for k, v in {**cors, "Cache-Control": "no-store", "Content-Length": "0"}.items():
                    self.send_header(k, v)
                self.end_headers()
                return
            start, end, size, body = PLAYER.open(target, self.headers.get("Range"))
        except bilidl_play.PlayError as e:
            if e.code >= 500:
                bilidl.log(f"在线播放出错（HTTP {e.code}）:", e)
            self._send_play_error(e.code, str(e), cors)
            return
        except Exception as e:
            bilidl.log("在线播放出错:", friendly(e))
            self._send_play_error(502, friendly(e), cors)
            return
        partial = self.headers.get("Range") is not None
        self.send_response(206 if partial else 200)
        hdrs = {**cors, "Content-Type": "video/mp4", "Content-Length": str(end - start + 1), "Accept-Ranges": "bytes",
                "Cache-Control": "no-store"}
        if partial:
            hdrs["Content-Range"] = f"bytes {start}-{end}/{size}"
        for k, v in hdrs.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            for piece in body:
                self.wfile.write(piece)
        except (ConnectionError, OSError):
            pass  # 播放器取消了请求（比如跳转）
        except bilidl_play.PlayError as e:  # 响应头已经发出，只能断开连接，播放器会重试
            bilidl.log("在线播放中途出错:", e)
            self.close_connection = True

    def _send_play_error(self, code, msg, cors):
        data = json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        for k, v in {**cors, "Content-Type": "application/json; charset=utf-8", "Content-Length": str(len(data)),
                     "Cache-Control": "no-store"}.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path not in POST_ROUTES:
            self._send(404, {"error": "not found"})
            return
        if not self._allowed(True):
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 65536:
                raise ValueError
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            self._send(400, {"error": "请求格式错误"})
            return
        self._call(POST_ROUTES[path], body)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # Windows 上 SO_REUSEADDR 会允许两个进程绑定同一端口

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        # 浏览器丢弃预先建好的连接、播放器取消请求时，对方会直接断开，不是错误，不往日志里打堆栈
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def main():
    background = sys.stdout is None
    if background:  # 用 pythonw 后台运行时没有控制台，日志写到文件（超过 1 MB 就清空重写）
        log_path = os.path.join(HOME, "bilidl-web.log")
        big = os.path.exists(log_path) and os.path.getsize(log_path) > 1 << 20
        sys.stdout = sys.stderr = open(log_path, "w" if big else "a", encoding="utf-8", buffering=1)
    else:
        for s in (sys.stdout, sys.stderr):
            s.reconfigure(encoding="utf-8", errors="replace")
    url = f"http://127.0.0.1:{PORT}/"
    no_browser = "--no-browser" in sys.argv
    try:
        srv = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"端口 {PORT} 已被占用，bilidl-web 可能已经在运行" + ("" if no_browser else f"，直接打开 {url}"))
        if not no_browser:
            webbrowser.open(url)
        return
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=sampler, daemon=True).start()
    global PLAYER
    PLAYER = bilidl_play.Cache(workers=default_threads())
    bilidl.log(f"bilidl-web 已启动：{url}  " + ("（后台运行，无窗口）" if background else "（关闭此窗口或按 Ctrl+C 停止）"))
    if not FFMPEG:
        bilidl.log("警告：找不到 ffmpeg，无法封装，请先安装：winget install Gyan.FFmpeg")
    if not no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        bilidl.log("正在停止…")
        with LOCK:
            running = [j for j in JOBS.values() if j.status == "running"]
        for j in running:
            j.cancel.set()
        deadline = time.time() + 5
        while time.time() < deadline and any(j.status == "running" for j in running):
            time.sleep(0.2)
        bilidl.log("已停止。未完成的分P下次重新下载时会断点续传。")


if __name__ == "__main__":
    main()
