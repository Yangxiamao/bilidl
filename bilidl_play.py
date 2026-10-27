"""在线播放加速：B 站网页播放器的 m4s 请求经 Chrome 扩展重定向到 bilidl-web，在这里按 1 MB 分块、
多线程从实测最快的节点拉取，并按播放器的实际取数速度提前预读。

播放器在 Worker 里用 XHR + Range 逐段请求，全部请求复用同一条 HTTP/2 连接，被 CDN 的单连接限速卡住。
这里把请求拆成 1 MB 的块，分到多条连接上并发拉取，再按顺序流式回给播放器。
预读窗口按「取数速度 × 90 秒」计算，倍速播放时取数速度变大，窗口也跟着变大。
数据只放在内存里，闲置 10 分钟就释放。原理和实测数据见 docs/PLAYBACK.md。
"""
import collections, itertools, queue, random, re, threading, time
import urllib.error, urllib.parse, urllib.request

import bilidl

CHUNK = bilidl.CHUNK
PLAY_AHEAD_SEC = 90                      # 预读领先播放器约 90 秒的数据
AHEAD_MIN, AHEAD_MAX = 32 << 20, 256 << 20
RATE_WINDOW = 20                         # 取数速度按最近 20 秒统计
RATE_WARMUP = 30                         # 刚开始（或跳转后）播放器在补自己约 70 秒的缓冲，这段时间的取数速度偏高，
WARMUP_AHEAD_SEC = 20                    # 所以只按它预读 20 秒：4K 补缓冲时能把并发拉起来，低画质也不会多拉太多
PLAY_MEM = 768 << 20                     # 所有视频合计的内存上限
IDLE_DROP = 600                          # 闲置 10 分钟整个释放
EXPLORE = 0.15                           # 预读块有 15% 随机分给其他节点，让速度排名跟得上节点的变化
SPREAD = 3                               # 其余预读块在最快的 3 个节点之间随机分：一个节点卡住时不会把所有线程都堵住
FETCH_TIMEOUT = 5                        # 连续这么多秒收不到数据就算失败（正常传输不受影响）
HEDGE_AFTER = 2.5                        # 播放器在等的块 2.5 秒还没拉完，就同时向另一个节点再拉一份，谁先到用谁
URGENT_WORKERS = 4                       # 另有 4 个线程只拉播放器在等的块，预读把普通线程占满时也不用排队
URGENT_WAIT = 30                         # 播放器的一个请求最多等 30 秒，超时就报错让播放器自己重试
AUDIO_IDS = {"30216", "30232", "30280", "30250", "30251"}
HEADERS = {"User-Agent": bilidl.UA, "Referer": "https://www.bilibili.com/"}
TARGET_HOST = re.compile(r"^upos-[a-z0-9-]+\.(bilivideo\.com|akamaized\.net)$")
# 扩展重定向过来的请求，Origin 会变成 null（跨源重定向），所以 null 也放行
ORIGIN_OK = re.compile(r"^(null|https://([a-z0-9-]+\.)*bilibili\.com)$")
RANGE = re.compile(r"^bytes=(\d+)-(\d*)$")


class PlayError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class Task:
    """一个块的下载任务。排队或下载中时登记在 Resource.tasks 里，同一个块只会拉一次。"""

    def __init__(self, res, idx, prio, gen):
        self.res, self.idx, self.prio, self.gen = res, idx, prio, gen
        self.started = self.finished = self.hedged = False
        self.waiters = 0
        self.running = 0         # 正在拉这个块的线程数（对冲时为 2）
        self.host = ""
        self.data = self.error = None
        self.event = threading.Event()


class Resource:
    """一个 m4s 文件（某个清晰度的视频流或音频流），以 URL 路径为键，与节点和签名无关。"""

    def __init__(self, key):
        self.key = key
        self.name = key.rsplit("/", 1)[-1]
        self.audio = self.name.rsplit("-", 1)[-1].split(".")[0] in AUDIO_IDS
        self.urls = {}           # host -> 最近收到的原始链接（签名会过期，以最新的为准）
        self.tmpl = None         # 最近收到的链接，换域名得到快节点的链接（akamai 的链接带同样的 upsig，换域名也有效）
        self.size = None
        self.chunks = {}         # idx -> bytes
        self.bytes = 0
        self.tasks = {}          # idx -> Task
        self.pos = 0             # 播放器已请求到的位置（下一个字节）
        self.gen = 0             # 跳转时加一，作废旧窗口里还没开始的预读
        self.floor = AHEAD_MIN   # 预读窗口下限，播放器追上预读时翻倍
        self.reqs = collections.deque()  # (时间, 字节数)：播放器的取数记录
        self.net = collections.deque()   # (时间, 字节数)：从 CDN 实际拉取的记录
        self.born = self.warm = self.used = time.time()
        self.host = ""
        self.fetches = 0         # 从 CDN 拉取成功的次数（用来确认同一块没有重复拉取；对冲的块可能拉到两份）
        self.hedges = 0
        self.dropped = False
        self.seeks = 0
        self.recent = collections.deque(maxlen=30)  # (相对时间, 起点, 终点, 是否命中, 是否算跳转)：排查用


class Cache:
    def __init__(self, workers=bilidl.WORKERS, log=bilidl.log):
        self.log = log
        self.lock = threading.Lock()
        self.res = {}            # key -> Resource
        self.mem = 0
        self.q = queue.PriorityQueue()   # (优先级, 序号, Task)：0 = 播放器在等，1 = 预读
        self.uq = queue.Queue()          # 只放优先级 0 的任务，给 URGENT_WORKERS 用
        self.seq = itertools.count()
        self.health = bilidl.HostHealth(log)
        for _ in range(max(1, min(int(workers), bilidl.MAX_WORKERS))):
            threading.Thread(target=self._worker, daemon=True).start()
        for _ in range(URGENT_WORKERS):
            threading.Thread(target=self._worker, args=(True,), daemon=True).start()
        threading.Thread(target=self._janitor, daemon=True).start()

    # ---------- 对外接口 ----------

    def open(self, url, range_header):
        """处理播放器的一个请求，返回 (start, end, size, 数据块迭代器)。end 含在内。"""
        res = self._resource(url)
        m = RANGE.match(range_header or "bytes=0-")
        if not m:
            raise PlayError(416, "不支持的 Range")
        start = int(m.group(1))
        with self.lock:
            hit = start // CHUNK in res.chunks
            # 请求覆盖的块一起以最高优先级排队、并发拉取，而不是等前一块拉完才排下一块（4K 一个请求常有 5~20 MB）
            last = start // CHUNK
            if m.group(2) and res.size:
                last = min(int(m.group(2)), res.size - 1) // CHUNK
            for idx in range(start // CHUNK, min(last, start // CHUNK + 31) + 1):
                if idx not in res.chunks:
                    self._push(res, idx, 0)
        first = self.chunk(res, start // CHUNK)
        size = res.size
        if start >= size:
            raise PlayError(416, "超出文件范围")
        end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
        self._note(res, start, end, hit)

        def body():
            for idx in range(start // CHUNK, end // CHUNK + 1):
                data = first if idx == start // CHUNK else self.chunk(res, idx)
                base = idx * CHUNK
                yield data[max(start - base, 0):end - base + 1]
        return start, end, size, body()

    def chunk(self, res, idx):
        """取一个块，没有就以最高优先级去拉，等它拉完。"""
        deadline = time.time() + URGENT_WAIT
        while True:
            with self.lock:
                data = res.chunks.get(idx)
                if data is not None:
                    return data
                t = self._push(res, idx, 0)
                t.waiters += 1
            try:
                done = t.event.wait(min(HEDGE_AFTER, max(deadline - time.time(), 0)))
                if not done:
                    with self.lock:
                        # 线程全被慢节点占住、这个块还没人拉时也对冲：对冲用的是单独的线程
                        hedge = not t.finished and not t.hedged
                        if hedge:
                            t.hedged = True
                            t.started = True
                            t.running += 1
                            res.hedges += 1
                    if hedge:
                        threading.Thread(target=self._hedge, args=(t,), daemon=True).start()
                    done = t.event.wait(max(deadline - time.time(), 0))
            finally:
                with self.lock:
                    t.waiters -= 1
            if not done:
                raise PlayError(504, f"{res.name} 第 {idx} 块等待超时")
            if t.data is not None:
                return t.data
            if t.error:
                raise PlayError(502, t.error)
            # 任务被作废（跳转后的预读）：重新排一次

    def stats(self):
        now = time.time()
        with self.lock:
            items = []
            for r in sorted(self.res.values(), key=lambda r: -r.used):
                win, rate = self._window(r, now)
                i = r.pos // CHUNK
                while i in r.chunks:
                    i += 1
                ahead = max(0, min(i * CHUNK, r.size or 0) - r.pos)
                items.append({"name": r.name, "kind": "audio" if r.audio else "video", "size": r.size, "pos": r.pos,
                              "cached": r.bytes, "chunks": len(r.chunks), "fetches": r.fetches, "hedges": r.hedges,
                              "ahead": ahead, "ahead_sec": round(ahead / rate, 1) if rate else None,
                              "rate": round(rate), "window": round(win), "host": r.host,
                              "speed": round(sum(n for t, n in r.net if t > now - 5) / 5), "idle": round(now - r.used, 1),
                              "seeks": r.seeks, "recent": list(r.recent)})
        with self.health.lock:
            hosts = sorted(({"host": h, "speed": round(s)} for h, s in self.health.speed.items()), key=lambda x: -x["speed"])
            cool = [h for h, t in self.health.cool.items() if t > now]
        return {"mem": self.mem, "mem_max": PLAY_MEM, "resources": items, "hosts": hosts, "cooling": cool}

    # ---------- 资源与调度（带 _ 的方法里，注明「持有锁」的要在 self.lock 内调用） ----------

    def _resource(self, url):
        p = urllib.parse.urlsplit(url)
        if p.scheme != "https" or p.port or not TARGET_HOST.match(p.hostname or "") or not p.path.endswith(".m4s"):
            raise PlayError(400, "不是 B 站视频分段链接")
        with self.lock:
            r = self.res.get(p.path)
            if r is None:
                r = self.res[p.path] = Resource(p.path)
            r.urls[p.hostname] = url
            r.tmpl = url
            r.used = time.time()
        return r

    def _window(self, r, now):
        """持有锁。返回 (预读窗口字节数, 播放器取数速度)。"""
        while r.reqs and r.reqs[0][0] < now - RATE_WINDOW:
            r.reqs.popleft()
        rate = sum(n for _, n in r.reqs) / max(min(RATE_WINDOW, now - r.warm), 2)
        secs = PLAY_AHEAD_SEC if now - r.warm > RATE_WARMUP else WARMUP_AHEAD_SEC
        return max(r.floor, min(rate * secs, AHEAD_MAX)), rate

    def _note(self, r, start, end, hit):
        """记下播放器的请求，处理跳转，并把预读窗口内缺的块排进队列。hit：请求开头的块是否已经预读好。"""
        now = time.time()
        seek = False
        with self.lock:
            win, _ = self._window(r, now)
            # 跳转：请求的块没缓存、又不在当前位置附近，作废旧窗口里没开始的预读。
            # 命中缓存的不算：4K 时浏览器的缓冲区装不下，播放器会回头再要一遍已经下过的数据
            if r.reqs and not hit and not (r.pos - 2 * CHUNK <= start <= r.pos + win):
                r.gen += 1
                r.seeks += 1
                seek = True
                r.reqs.clear()
                r.warm = now
                r.floor = AHEAD_MIN
            elif r.reqs and now - r.warm > RATE_WARMUP and not hit:
                r.floor = min(r.floor * 2, AHEAD_MAX)  # 播放器追上了预读（比如刚切到更高倍速），先把窗口翻倍
            r.recent.append((round(now - r.born, 1), start, end, hit, seek))
            if hit and end < r.pos:
                return  # 回头再要已缓存的数据：不算取数速度，也不把位置往回挪
            r.reqs.append((now, end - start + 1))
            r.pos = end + 1
            if self.mem > PLAY_MEM:
                return
            win, _ = self._window(r, now)
            for idx in range(r.pos // CHUNK, (min(r.pos + int(win), r.size) - 1) // CHUNK + 1):
                if idx not in r.chunks and idx not in r.tasks:
                    self._push(r, idx, 1)

    def _push(self, r, idx, prio):
        """持有锁。排一个块；已在排队的低优先级任务会被提到 prio。"""
        t = r.tasks.get(idx)
        if t is None:
            t = r.tasks[idx] = Task(r, idx, prio, r.gen)
        elif t.started or t.prio <= prio:
            return t
        t.prio = prio
        self.q.put((prio, next(self.seq), t))
        if prio == 0:
            self.uq.put(t)
        return t

    def _finish(self, t):
        """持有锁。"""
        if t.res.tasks.get(t.idx) is t:
            del t.res.tasks[t.idx]
        t.finished = True
        t.event.set()

    def _worker(self, urgent_only=False):
        while True:
            prio, _, t = (0, 0, self.uq.get()) if urgent_only else self.q.get()
            r = t.res
            with self.lock:
                if t.started or t.finished or prio != t.prio:
                    continue  # 已被别的线程拿走，或是提升优先级后留下的旧队列项
                if t.prio > 0 and not t.waiters and (t.gen != r.gen or r.dropped):
                    self._finish(t)  # 跳转或释放后作废的预读
                    continue
                t.started = True
                t.running = 1
            data, err = self._fetch(t, t.prio == 0)
            with self.lock:
                self._complete(t, data, err)
            if self.mem > PLAY_MEM:
                self._evict()

    def _hedge(self, t):
        data, err = self._fetch(t, True, avoid=t.host)
        with self.lock:
            self._complete(t, data, err)

    def _complete(self, t, data, err):
        """持有锁。对冲时两路都会调用：先成功的那路生效；一路失败而另一路还在拉时先不报错。"""
        t.running -= 1
        if t.finished or (data is None and t.running > 0):
            return
        r = t.res
        t.data, t.error = data, err
        if data is not None and not r.dropped and t.idx not in r.chunks:
            r.chunks[t.idx] = data
            r.bytes += len(data)
            self.mem += len(data)
        self._finish(t)

    def _candidates(self, r):
        """返回 (参与测速排序的节点, 最后才用的节点)。akamai 单连接不慢，但总带宽只有约 1 MB/s、加线程也不涨，
        按单连接速度排序会被误判成快节点，所以只在第 3 次重试时用。"""
        with self.lock:
            tmpl, urls = r.tmpl, list(r.urls.values())
        fast = [urllib.parse.urlsplit(tmpl)._replace(netloc=h).geturl() for h in bilidl.FAST_HOSTS] if tmpl else []
        akam = [u for u in urls if bilidl.host_of(u).endswith(".akamaized.net")]
        main = list(dict.fromkeys(fast + [u for u in urls if u not in akam]))
        return main or akam, akam if main else []

    def _pick(self, cands, urgent, attempt, avoid=None):
        cands, backup = cands
        if attempt == 2 and backup:
            return backup[0]
        ranked = self.health.ranked(cands, unknown_first=not urgent)
        if avoid and len(ranked) > 1:
            ranked = [u for u in ranked if bilidl.host_of(u) != avoid] or ranked
        if attempt:
            return ranked[attempt % len(ranked)]
        if not urgent and len(ranked) > 1:
            if len(ranked) > SPREAD and random.random() < EXPLORE:
                return random.choice(ranked[SPREAD:])
            return random.choice(ranked[:SPREAD])
        return ranked[0]

    def _fetch(self, t, urgent, avoid=None):
        r, start = t.res, t.idx * CHUNK
        err = None
        for attempt in range(4 if urgent else 3):
            u = self._pick(self._candidates(r), urgent, attempt, avoid)
            t.host = bilidl.host_of(u)
            end = start + CHUNK - 1
            if r.size:
                end = min(end, r.size - 1)
            t0 = time.time()
            try:
                req = urllib.request.Request(u, headers={**HEADERS, "Range": f"bytes={start}-{end}"})
                with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                    size = int(resp.headers["Content-Range"].split("/")[1])
                    data = resp.read()
                need = min(end, size - 1) - start + 1
                if len(data) != need:
                    raise IOError(f"short read {len(data)}/{need}")
                dt = time.time() - t0
                # 文件末尾不足半块的测不准速度，只记成功
                self.health.ok(u, nbytes=len(data) if len(data) >= CHUNK // 2 else 0, sec=dt)
                with self.lock:
                    r.size = size
                    r.host = bilidl.host_of(u)
                    r.fetches += 1
                    r.net.append((time.time(), len(data)))
                return data, None
            except urllib.error.HTTPError as e:
                err = e
                self.health.fail(u, e)
                if e.code == 416:
                    break
            except Exception as e:
                err = e
                self.health.fail(u, e)
            if not urgent:
                time.sleep(1 + attempt)
        return None, f"{type(err).__name__}: {err}"

    def _drop(self, r):
        """持有锁。"""
        r.dropped = True
        self.mem -= r.bytes
        r.chunks.clear()
        r.bytes = 0
        self.res.pop(r.key, None)

    def _evict(self):
        """超过内存上限时，先丢各资源播放位置之前的块，再整个释放最久没用的资源。"""
        now = time.time()
        with self.lock:
            target = PLAY_MEM * 0.9
            for r in sorted(self.res.values(), key=lambda r: r.used):
                for i in [i for i in r.chunks if (i + 1) * CHUNK <= r.pos - CHUNK]:
                    n = len(r.chunks.pop(i))
                    r.bytes -= n
                    self.mem -= n
                if self.mem <= target:
                    return
            for r in sorted(self.res.values(), key=lambda r: r.used):
                if now - r.used < 30:  # 正在播放的不动
                    break
                self._drop(r)
                if self.mem <= target:
                    return

    def _janitor(self):
        while True:
            time.sleep(30)
            now = time.time()
            with self.lock:
                for r in list(self.res.values()):
                    if now - r.used > IDLE_DROP:
                        self._drop(r)
                    while r.net and r.net[0][0] < now - 10:
                        r.net.popleft()
