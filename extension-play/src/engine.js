// 播放加速的缓存和调度（由已删除的本地代理 bilidl_play.py 移植而来），跑在 bilibili.com 页面里（每个标签页一份）。
// 播放器的一个分段请求被拆成 1 MB 的块，从实测最快的几个节点并发拉取；同时按播放器的取数速度预读约 90 秒。
// CDN 按单个请求（HTTP/2 stream）限速，所以同一条连接上的并发请求也能叠加速度（见 docs/EXTENSION_ONLY.md）。
// 这里不碰 XHR 和 DOM，fetch 由外面传进来，可以在 Node 里离线测试（tests/play_engine_test.mjs）。
import { UPOS, hostOf, nowSec, HostHealth, candidates, pick } from "../../shared/hosts.js";

export const CHUNK = 1 << 20;
const MB = 1 << 20;
// 三档配置，用户在弹出页里选。workers：预读也能用的并发数；urgent：只拉播放器在等的块的并发数，预读把普通并发占满时也不用排队
export const PROFILES = {
  low:  { label: "低", workers: 6,  urgent: 3, aheadSec: 60,  aheadMax: 128 * MB, mem: 256 * MB },
  mid:  { label: "中", workers: 12, urgent: 4, aheadSec: 90,  aheadMax: 256 * MB, mem: 512 * MB },
  high: { label: "高", workers: 24, urgent: 6, aheadSec: 120, aheadMax: 512 * MB, mem: 1024 * MB },
};
export const DEFAULT_PROFILE = "mid";
// 时间参数（秒），测试时可以调小
export const TIMING = {
  fetchTimeout: 5,     // 连续这么多秒收不到数据就算失败（正常传输不受影响）
  chunkDeadline: 10,   // 一块（1 MB）拉了 10 秒还没拉完也算失败：慢节点一直有数据、不会触发上面的超时，但会长时间占着一个并发
  hedgeAfter: 2.5,     // 播放器在等的块 2.5 秒还没拉完，就同时向另一个节点再拉一份，谁先到用谁
  urgentWait: 30,      // 播放器的一个请求最多等 30 秒，超时就退回直连
  retryDelay: 1,       // 预读块失败后等 1、2 秒再重试
  rateWindow: 20,      // 取数速度按最近 20 秒统计
  rateWarmup: 30,      // 刚开始（或跳转后）播放器在补自己约 70 秒的缓冲，这段时间的取数速度偏高，
  warmupAheadSec: 20,  // 所以只按它预读 20 秒：4K 补缓冲时能把并发拉起来，低画质也不会多拉太多
  idleDrop: 600,       // 闲置 10 分钟整个释放
  keepRecent: 30,      // 内存超限时，30 秒内用过的资源不整个释放
  slowLog: 10,         // 播放器等一个块超过 10 秒就记一笔，排查卡顿用
  janitor: 30,
};
const AHEAD_MIN = 32 * MB;
const URGENT_SPAN = 32;  // 一个请求最多先排 32 块，其余的等前面的拿到再排
const MAX_EXPLORE = 1;   // 预读时同一时间最多 1 个请求去试没测过的或慢的节点
const AUDIO_IDS = new Set(["30216", "30232", "30280", "30250", "30251"]);

const sleep = sec => new Promise(r => setTimeout(r, sec * 1000));

class HttpError extends Error {
  constructor(status) { super("HTTP " + status); this.status = status; }
}

/** 一个块的下载任务。排队或下载中时登记在 Resource.tasks 里，同一个块只会拉一次。 */
class Task {
  constructor(res, idx, prio, gen) {
    Object.assign(this, { res, idx, prio, gen });
    this.started = this.finished = this.hedged = this.slowLogged = false;
    this.waiters = 0;
    this.running = 0;          // 正在拉这个块的路数（对冲时为 2）
    this.host = "";
    this.data = this.error = null;
    this.ctls = new Set();     // 在飞的 fetch，一路成功后取消另一路
    this.done = new Promise(r => { this.resolve = r; });
  }
}

/** 一个 m4s 文件（某个清晰度的视频流或音频流），以 URL 路径为键，与节点和签名无关。 */
class Resource {
  constructor(key, now) {
    this.key = key;
    this.name = key.slice(key.lastIndexOf("/") + 1);
    this.audio = AUDIO_IDS.has(this.name.split("-").pop().split(".")[0]);
    this.urls = new Map();     // host -> 最近收到的原始链接（签名会过期，以最新的为准）
    this.tmpl = null;          // 最近收到的链接，换域名得到快节点的链接
    this.size = null;
    this.chunks = new Map();   // idx -> Uint8Array
    this.bytes = 0;
    this.tasks = new Map();    // idx -> Task
    this.pos = 0;              // 播放器已请求到的位置（下一个字节）
    this.gen = 0;              // 跳转时加一，作废旧窗口里还没开始的预读
    this.floor = AHEAD_MIN;    // 预读窗口下限，播放器追上预读时翻倍
    this.reqs = [];            // [时间, 字节数]：播放器的取数记录
    this.net = [];             // [时间, 字节数]：从 CDN 实际拉取的记录
    this.born = this.warm = this.used = now;
    this.host = "";
    this.fetches = 0;          // 从 CDN 拉取成功的次数（确认同一块没有重复拉取；对冲的块可能拉到两份）
    this.hedges = 0;
    this.seeks = 0;
    this.dropped = false;
  }
}

export class Engine {
  /** opts.fetch：用来拉数据的 fetch（页面里传接管前保存的原生 fetch）；opts.profile；opts.timing 覆盖 TIMING。 */
  constructor({ fetch, profile = DEFAULT_PROFILE, timing = {}, now = nowSec, random = Math.random } = {}) {
    this.fetch = fetch;
    this.now = now;
    this.random = random;
    this.T = { ...TIMING, ...timing };
    this.setProfile(profile);
    this.res = new Map();      // key -> Resource
    this.mem = 0;
    this.q = [];               // 预读任务（优先级 1），先进先出
    this.uq = [];              // 播放器在等的任务（优先级 0）
    this.active = 0;           // 普通并发在用的数量
    this.activeUrgent = 0;
    this.exploring = 0;        // 在飞的试探请求数
    this.logs = [];
    this.hostStats = new Map();  // host -> { ok, fail, bytes, sec }：统计用
    this.health = new HostHealth(m => this.log(m), now);
    this.janitor = setInterval(() => this._janitor(), this.T.janitor * 1000);
  }

  setProfile(name) {
    this.profileName = PROFILES[name] ? name : DEFAULT_PROFILE;
    this.P = PROFILES[this.profileName];
    if (this.q) this._pump();
  }

  close() {
    clearInterval(this.janitor);
    this.clear();
  }

  /** 释放所有缓存（关闭加速时用）。在飞的拉取照常完成，结果丢掉。 */
  clear() {
    for (const r of [...this.res.values()]) this._drop(r);
  }

  log(msg) {
    this.logs.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (this.logs.length > 30) this.logs.shift();
  }

  /** 是不是我们能接管的链接：upos 节点上的 .m4s。 */
  static accepts(url) {
    try {
      const p = new URL(url);
      return p.protocol === "https:" && !p.port && UPOS.test(p.hostname) && p.pathname.endsWith(".m4s");
    } catch { return false; }
  }

  /** 处理播放器的一个请求 bytes=a-b（b 含在内），返回 { data: ArrayBuffer, start, end, size }。
   *  出任何错都抛异常，由调用方改发原请求（退回直连）。signal：播放器取消请求时中止等待（块照常拉完，留着备用）。 */
  async request(url, a, b, signal) {
    const res = this._resource(url);
    const first = Math.floor(a / CHUNK);
    if (res.size != null && a >= res.size) throw new Error("超出文件范围");
    const hit = res.chunks.has(first);
    // 请求覆盖的块一起以最高优先级排队、并发拉取，而不是等前一块拉完才排下一块（4K 一个请求常有 5~20 MB）
    const last = Math.floor((res.size ? Math.min(b, res.size - 1) : b) / CHUNK);
    for (let i = first; i <= Math.min(last, first + URGENT_SPAN - 1); i++)
      if (!res.chunks.has(i)) this._push(res, i, 0);
    const deadline = this.now() + this.T.urgentWait;
    const head = await this._chunk(res, first, deadline, signal);
    const size = res.size;
    if (a >= size) throw new Error("超出文件范围");
    const end = Math.min(b, size - 1);
    this._note(res, a, end, hit);
    const idxs = [];
    for (let i = first + 1; i <= Math.floor(end / CHUNK); i++) idxs.push(i);
    const parts = [head, ...await Promise.all(idxs.map(i => this._chunk(res, i, deadline, signal)))];
    const out = new Uint8Array(end - a + 1);
    let o = 0;
    parts.forEach((d, k) => {
      const base = (first + k) * CHUNK;
      const piece = d.subarray(Math.max(a - base, 0), Math.min(end - base + 1, d.length));
      out.set(piece, o);
      o += piece.length;
    });
    if (o !== out.length) throw new Error(`拼出来的长度不对 ${o}/${out.length}`);
    return { data: out.buffer, start: a, end, size };
  }

  stats() {
    const now = this.now();
    const items = [...this.res.values()].sort((x, y) => y.used - x.used).map(r => {
      const [win, rate] = this._window(r, now);
      let i = Math.floor(r.pos / CHUNK);
      while (r.chunks.has(i)) i++;
      const ahead = Math.max(0, Math.min(i * CHUNK, r.size || 0) - r.pos);
      return { name: r.name, kind: r.audio ? "audio" : "video", size: r.size, pos: r.pos, cached: r.bytes,
               chunks: r.chunks.size, fetches: r.fetches, hedges: r.hedges, seeks: r.seeks,
               ahead, aheadSec: rate ? +(ahead / rate).toFixed(1) : null, rate: Math.round(rate), window: Math.round(win),
               host: r.host, speed: Math.round(r.net.filter(([t]) => t > now - 5).reduce((s, [, n]) => s + n, 0) / 5),
               idle: +(now - r.used).toFixed(1) };
    });
    const hosts = [...this.health.speed].map(([host, s]) => ({ host, speed: Math.round(s), ...this.hostStats.get(host) }))
      .sort((x, y) => y.speed - x.speed);
    return { profile: this.profileName, mem: this.mem, memMax: this.P.mem, active: this.active, activeUrgent: this.activeUrgent,
             queued: this.q.length, resources: items, hosts, cooling: this.health.cooling(), logs: this.logs.slice(-10) };
  }

  // ---------- 资源与调度 ----------

  _resource(url) {
    if (!Engine.accepts(url)) throw new Error("不是 B 站视频分段链接");
    const p = new URL(url);
    let r = this.res.get(p.pathname);
    if (!r) this.res.set(p.pathname, r = new Resource(p.pathname, this.now()));
    r.urls.set(p.hostname, url);
    r.tmpl = url;
    r.used = this.now();
    return r;
  }

  /** 返回 [预读窗口字节数, 播放器取数速度]。窗口 = 取数速度 × 90 秒，取数速度已经包含了码率和倍速。 */
  _window(r, now) {
    const T = this.T;
    while (r.reqs.length && r.reqs[0][0] < now - T.rateWindow) r.reqs.shift();
    const rate = r.reqs.reduce((s, [, n]) => s + n, 0) / Math.max(Math.min(T.rateWindow, now - r.warm), 2);
    const secs = now - r.warm > T.rateWarmup ? this.P.aheadSec : T.warmupAheadSec;
    return [Math.max(r.floor, Math.min(rate * secs, this.P.aheadMax)), rate];
  }

  /** 记下播放器的请求，处理跳转，并把预读窗口内缺的块排进队列。hit：请求开头的块是否已经预读好。 */
  _note(r, start, end, hit) {
    const now = this.now();
    let seek = false;
    let [win] = this._window(r, now);
    // 跳转：请求的块没缓存、又不在当前位置附近，作废旧窗口里没开始的预读。
    // 命中缓存的不算：4K 时浏览器的缓冲区装不下，播放器会回头再要一遍已经下过的数据
    if (r.reqs.length && !hit && !(r.pos - 2 * CHUNK <= start && start <= r.pos + win)) {
      r.gen++;
      r.seeks++;
      seek = true;
      r.reqs = [];
      r.warm = now;
      r.floor = AHEAD_MIN;
    } else if (r.reqs.length && now - r.warm > this.T.rateWarmup && !hit) {
      r.floor = Math.min(r.floor * 2, this.P.aheadMax);  // 播放器追上了预读（比如刚切到更高倍速），先把窗口翻倍
    }
    if (seek) this.log(`${r.name} 跳转到 ${(start / MB).toFixed(0)} MB`);
    if (hit && end < r.pos) return;  // 回头再要已缓存的数据：不算取数速度，也不把位置往回挪
    r.reqs.push([now, end - start + 1]);
    r.pos = end + 1;
    if (this.mem > this.P.mem) return;
    [win] = this._window(r, now);
    const stop = Math.floor((Math.min(r.pos + Math.floor(win), r.size) - 1) / CHUNK);
    for (let i = Math.floor(r.pos / CHUNK); i <= stop; i++)
      if (!r.chunks.has(i) && !r.tasks.has(i)) this._push(r, i, 1);
  }

  /** 排一个块；已在排队的低优先级任务会被提到 prio。 */
  _push(r, idx, prio) {
    let t = r.tasks.get(idx);
    if (!t) {
      r.tasks.set(idx, t = new Task(r, idx, prio, r.gen));
    } else if (t.started || t.prio <= prio) {
      return t;
    }
    t.prio = prio;
    (prio === 0 ? this.uq : this.q).push(t);
    this._pump();
    return t;
  }

  /** 从队列里取下一个能开始的任务，跳过已被拿走、提升过优先级、因跳转作废、或者超过内存上限的预读（下次请求时会重新排）。 */
  _take(queue, prio) {
    while (queue.length) {
      const t = queue.shift();
      if (t.started || t.finished || t.prio !== prio) continue;
      if (t.prio > 0 && !t.waiters && (t.gen !== t.res.gen || t.res.dropped || this.mem > this.P.mem)) {
        this._finish(t);
        continue;
      }
      return t;
    }
    return null;
  }

  _pump() {
    for (let t; this.activeUrgent < this.P.urgent && (t = this._take(this.uq, 0));) this._start(t, true);
    for (let t; this.active < this.P.workers && (t = this._take(this.uq, 0) || this._take(this.q, 1));) this._start(t, false);
  }

  _start(t, urgentPool) {
    t.started = true;
    t.running = 1;
    urgentPool ? this.activeUrgent++ : this.active++;
    this._fetch(t, t.prio === 0).then(([data, err]) => {
      urgentPool ? this.activeUrgent-- : this.active--;
      this._complete(t, data, err);
      if (this.mem > this.P.mem) this._evict();
      this._pump();
    });
  }

  /** 取一个块，没有就以最高优先级去拉，等它拉完；等了 hedgeAfter 秒还没拉完就对冲。 */
  async _chunk(res, idx, deadline, signal) {
    const t0 = this.now();
    for (;;) {
      const have = res.chunks.get(idx);
      if (have) return have;
      const t = this._push(res, idx, 0);
      t.waiters++;
      let done;
      try {
        done = await this._wait(t, Math.min(this.T.hedgeAfter, deadline - this.now()), signal);
        // 并发全被慢节点占住、这个块还没人拉时也对冲：对冲不占并发名额
        if (!done && !t.finished && !t.hedged) {
          t.hedged = t.started = true;
          t.running++;
          res.hedges++;
          this._fetch(t, true, t.host).then(([data, err]) => this._complete(t, data, err));
        }
        if (!done) done = await this._wait(t, deadline - this.now(), signal);
      } finally {
        t.waiters--;
      }
      if (!done) throw new Error(`${res.name} 第 ${idx} 块等待超时`);
      if (t.data) {
        const dt = this.now() - t0;
        if (dt >= this.T.slowLog && !t.slowLogged) {
          t.slowLogged = true;
          this.log(`等待较久：${res.name} 第 ${idx} 块 ${dt.toFixed(1)} 秒（节点 ${t.host}${t.hedged ? "，已对冲" : ""}）`);
        }
        return t.data;
      }
      if (t.error) throw new Error(t.error);
      // 任务被作废（跳转后的预读）：重新排一次
    }
  }

  /** 等任务完成，返回 true；超时返回 false；signal 中止时抛异常。 */
  _wait(t, sec, signal) {
    if (t.finished) return Promise.resolve(true);
    if (signal?.aborted) return Promise.reject(new Error("已取消"));
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => { cleanup(); ok(false); }, Math.max(sec, 0) * 1000);
      const onAbort = () => { cleanup(); bad(new Error("已取消")); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      signal?.addEventListener("abort", onAbort);
      t.done.then(() => { cleanup(); ok(true); });
    });
  }

  /** 对冲时两路都会调用：先成功的那路生效并取消另一路；一路失败而另一路还在拉时先不报错。 */
  _complete(t, data, err) {
    t.running--;
    if (t.finished || (data == null && t.running > 0)) return;
    const r = t.res;
    t.data = data;
    t.error = err;
    if (data && !r.dropped && !r.chunks.has(t.idx)) {
      r.chunks.set(t.idx, data);
      r.bytes += data.length;
      this.mem += data.length;
    }
    this._finish(t);
    for (const c of t.ctls) c.abort(new Error("另一路先拉完了"));
  }

  _finish(t) {
    if (t.res.tasks.get(t.idx) === t) t.res.tasks.delete(t.idx);
    t.finished = true;
    t.resolve();
  }

  async _fetch(t, urgent, avoid = null) {
    const r = t.res, start = t.idx * CHUNK;
    let err;
    for (let attempt = 0; attempt < (urgent ? 4 : 3); attempt++) {
      if (t.finished) return [null, "已完成"];
      const { url: u, explore } = pick(this.health, candidates(r.tmpl, [...r.urls.values()]), urgent, attempt,
                                       { avoid, canExplore: this.exploring < MAX_EXPLORE, rnd: this.random });
      t.host = hostOf(u);
      if (explore) this.exploring++;
      const end = r.size ? Math.min(start + CHUNK - 1, r.size - 1) : start + CHUNK - 1;
      const t0 = this.now();
      const ctl = new AbortController();
      t.ctls.add(ctl);
      try {
        const { data, total } = await this._get(u, start, end, ctl);
        // 文件末尾不足半块的测不准速度，只记成功
        this.health.ok(u, data.length >= CHUNK / 2 ? data.length : 0, this.now() - t0);
        this._count(t.host, true, data.length, this.now() - t0);
        r.size = total;
        r.host = t.host;
        r.fetches++;
        r.net.push([this.now(), data.length]);
        return [data, null];
      } catch (e) {
        if (t.finished) return [null, "已完成"];  // 另一路先拉完，这一路被取消
        err = e;
        this.health.fail(u, e.message || e);
        this._count(t.host, false, 0, this.now() - t0);
        if (e.status === 416) break;
      } finally {
        t.ctls.delete(ctl);
        if (explore) this.exploring--;
      }
      if (!urgent) await sleep(this.T.retryDelay * (1 + attempt));
    }
    return [null, String(err && err.message || err)];
  }

  _count(host, ok, bytes, sec) {
    let c = this.hostStats.get(host);
    if (!c) this.hostStats.set(host, c = { ok: 0, fail: 0, bytes: 0, sec: 0 });
    ok ? c.ok++ : c.fail++;
    c.bytes += bytes;
    c.sec += sec;
  }

  /** 拉 bytes=a-b，连续 fetchTimeout 秒收不到数据、或者总共超过 chunkDeadline 秒就中止。返回 { data: Uint8Array, total }。 */
  async _get(url, a, b, ctl) {
    let timer;
    const deadline = setTimeout(() => ctl.abort(new Error("timed out（太慢）")), this.T.chunkDeadline * 1000);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error("timed out")), this.T.fetchTimeout * 1000);
    };
    arm();
    try {
      const resp = await this.fetch(url, { headers: { Range: `bytes=${a}-${b}` }, signal: ctl.signal,
                                           credentials: "omit", cache: "no-store" });
      if (resp.status !== 206) {
        resp.body?.cancel().catch(() => {});
        throw new HttpError(resp.status);
      }
      const total = Number((resp.headers.get("Content-Range") || "").split("/")[1]);
      if (!(total > 0)) throw new Error("没有 Content-Range");
      const need = Math.min(b, total - 1) - a + 1;
      const out = new Uint8Array(need);
      let o = 0;
      const rd = resp.body.getReader();
      for (;;) {
        arm();
        const { done, value } = await rd.read();
        if (done) break;
        if (o + value.length > need) throw new Error("数据比请求的长");
        out.set(value, o);
        o += value.length;
      }
      if (o !== need) throw new Error(`short read ${o}/${need}`);
      return { data: out, total };
    } catch (e) {
      throw ctl.signal.aborted && ctl.signal.reason ? ctl.signal.reason : e;
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
    }
  }

  _drop(r) {
    r.dropped = true;
    this.mem -= r.bytes;
    r.chunks.clear();
    r.bytes = 0;
    this.res.delete(r.key);
  }

  /** 超过内存上限时，先丢各资源播放位置之前的块，再整个释放最久没用的资源。 */
  _evict() {
    const now = this.now(), target = this.P.mem * 0.9;
    const byUse = () => [...this.res.values()].sort((x, y) => x.used - y.used);
    for (const r of byUse()) {
      for (const [i, d] of [...r.chunks]) {
        if ((i + 1) * CHUNK <= r.pos - CHUNK) {
          r.chunks.delete(i);
          r.bytes -= d.length;
          this.mem -= d.length;
        }
      }
      if (this.mem <= target) return;
    }
    for (const r of byUse()) {
      if (now - r.used < this.T.keepRecent) break;  // 正在播放的不动
      this._drop(r);
      if (this.mem <= target) return;
    }
  }

  _janitor() {
    const now = this.now();
    for (const r of [...this.res.values()]) {
      if (now - r.used > this.T.idleDrop) this._drop(r);
      while (r.net.length && r.net[0][0] < now - 10) r.net.shift();
    }
  }
}
