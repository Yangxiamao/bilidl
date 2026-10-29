// 下载一个分P：视频、音频两个流按 1 MB 分段并发下载，每段直接写到合成后的 mp4 里的位置（布局见 mux.js）。
// 和 bilidl.py 的 Downloader 是同一个思路，只是从线程换成了异步并发；挑节点用 shared/hosts.js（和播放加速插件一样按实测速度加权）。
// 不碰 OPFS、IndexedDB 和插件 API：fetch、写文件、刷新链接都从外面传进来，可以离线测。
import { HostHealth, candidates, pick, hostOf } from "../../shared/hosts.js";
import { place, span, outOffset } from "./mux.js";

export const CHUNK = 1 << 20;  // 不要改：断点续传的进度按「第几个 1 MB」记录
export const WORKERS = 16, MAX_WORKERS = 32;
const STALL = 8;          // 秒：这么久收不到新数据就放弃这次请求（换节点重试）
const SLOW = 20;          // 秒：一段拉了这么久还没完也放弃，慢节点最多占一个并发 20 秒
const HEDGE_AFTER = 3;    // 秒：没有新分段可拉时，已经拉了这么久的分段向另一个节点再拉一份，先到的算数
const REFRESH_MIN = 10;   // 秒：多个分段同时遇到过期链接时只刷新一次，避免 playurl 被 412
const ATTEMPTS = 30;

const sleep = (ms, signal) => new Promise((ok, bad) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); bad(signal.reason); }, { once: true });
});

/** 所有分段：[{ t: 轨道, i: 第几段, start, end, out: 在输出文件里的位置 }]，按输出位置排列（顺着文件写）。 */
export function chunkList(lay) {
  const out = [];
  lay.tracks.forEach((_, t) => {
    const [a, b] = span(lay, t);
    for (let i = 0, s = a; s < b; i++, s += CHUNK) out.push({ t, i, start: s, end: Math.min(s + CHUNK, b), out: outOffset(lay, t, s) });
  });
  return out.sort((x, y) => x.out - y.out);
}

/** 每条轨道的分段数，用来建进度位图（每段 1 个字节，0 / 1）。 */
export const chunkCounts = lay => lay.tracks.map((_, t) => { const [a, b] = span(lay, t); return Math.ceil((b - a) / CHUNK); });

export class Download {
  /**
   * lay：mux.layout() 的结果；streams[t]：{ tmpl, urls }（api.streamUrls）；refresh(t)：重新请求 playurl，返回新的 { tmpl, urls }；
   * done[t]：进度位图（Uint8Array，已完成的段为 1，会被就地修改）；write(位置, 数据)：写进输出文件；
   * onChunk(t, i)：一段写完后调用（调用方据此保存进度）。
   */
  constructor({ lay, streams, refresh, done, write, onChunk = () => {}, fetch = globalThis.fetch.bind(globalThis),
                workers = WORKERS, log = () => {}, now = () => performance.now() / 1000,
                stall = STALL, slow = SLOW, hedgeAfter = HEDGE_AFTER }) {
    Object.assign(this, { lay, streams, refresh, done, write, onChunk, fetch, log, now, stall, slow, hedgeAfter });
    this.workers = Math.max(1, Math.min(workers | 0, MAX_WORKERS));
    this.health = new HostHealth(log, now);
    this.refreshed = streams.map(() => -Infinity);
    this.hits = new Map();
    this.exploring = 0;
    this.net = 0;           // 本次实际下载的字节（不含续传前已有的）
    this.marks = [];        // [时间, net]，算最近的速度
    const all = chunkList(lay);
    this.total = all.reduce((s, c) => s + c.end - c.start, 0);
    this.todo = all.filter(c => !done[c.t][c.i]);
    this.doneBytes = this.total - this.todo.reduce((s, c) => s + c.end - c.start, 0);
    this.inflight = new Map();  // 段 -> { started, hedged, ctls, done }
  }

  progress() {
    const t = this.now();
    this.marks.push([t, this.net]);
    while (this.marks.length > 2 && t - this.marks[0][0] > 5) this.marks.shift();
    const [t0, n0] = this.marks[0];
    return { done: this.doneBytes, total: this.total, speed: t > t0 ? (this.net - n0) / (t - t0) : 0,
             hosts: Object.fromEntries(this.hits), cooling: this.health.cooling() };
  }

  /** 全部下完时返回；signal 取消时抛出 signal.reason；某段重试 30 次仍失败时抛错（已下的部分保留，可以续传）。 */
  async run(signal) {
    let fatal = null;
    const loop = async () => {
      while (!fatal) {
        signal?.throwIfAborted();
        let c = this.todo.shift(), hedge = false;
        if (!c) {
          const now = this.now();
          const slow = [...this.inflight].find(([, e]) => !e.done && !e.hedged && now - e.started > this.hedgeAfter);
          if (!slow) {
            if (![...this.inflight.values()].some(e => !e.done)) return;
            await sleep(300, signal);
            continue;
          }
          [c] = slow;
          slow[1].hedged = true;
          hedge = true;
        }
        try { await this.chunk(c, hedge, signal); }
        catch (e) { if (signal?.aborted) throw signal.reason; fatal = e; }
      }
    };
    await Promise.allSettled(Array.from({ length: this.workers }, loop));
    signal?.throwIfAborted();
    if (fatal) throw fatal;
  }

  async chunk(c, hedge, signal) {
    let e = this.inflight.get(c);
    if (!e) this.inflight.set(c, e = { started: this.now(), hedged: false, ctls: new Set(), done: false, host: "" });
    for (let attempt = 0; attempt < ATTEMPTS && !e.done; attempt++) {
      signal?.throwIfAborted();
      const s = this.streams[c.t];
      const canExplore = this.exploring === 0;
      const { url, explore } = pick(this.health, candidates(s.tmpl, s.urls), false, attempt, { avoid: hedge ? e.host : null, canExplore });
      if (!hedge) e.host = hostOf(url);
      if (explore) this.exploring++;
      const ctl = new AbortController();
      const stop = () => ctl.abort(signal.reason);
      signal?.addEventListener("abort", stop, { once: true });
      e.ctls.add(ctl);
      const t0 = this.now();
      try {
        const data = await this.get(url, c.start, c.end, ctl);
        if (e.done) return;  // 对冲的另一路先到了
        e.done = true;
        for (const other of e.ctls) if (other !== ctl) other.abort(new Error("对冲的另一路先到了"));
        for (const [pos, part] of place(this.lay, c.t, c.start, data)) await this.write(pos, part);
        this.done[c.t][c.i] = 1;
        this.doneBytes += data.length;
        this.net += data.length;
        this.health.ok(url, data.length, this.now() - t0);
        this.hits.set(hostOf(url), (this.hits.get(hostOf(url)) || 0) + 1);
        this.inflight.delete(c);
        this.onChunk(c.t, c.i);
        return;
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (e.done) return;
        this.health.fail(url, err.message || err);
        if (hedge) return;  // 对冲只试一次，原来那一路还在继续
        if (err.status === 403 || err.status === 404) await this.refreshLinks(c.t);
        await sleep(Math.min(1000 * (1 + attempt), 15000), signal);
      } finally {
        if (explore) this.exploring--;
        e.ctls.delete(ctl);
        signal?.removeEventListener("abort", stop);
      }
    }
    if (!e.done) throw new Error(`分段 ${c.t}:${c.i} 重试 ${ATTEMPTS} 次仍失败`);
  }

  /** 取 [start, end) 一段。STALL 秒没有新数据、或总共超过 SLOW 秒就放弃（错误信息带 timed out，挑节点时罚得更重）。 */
  async get(url, start, end, ctl) {
    let stall;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(new Error("timed out（没有新数据）")), this.stall * 1000); };
    const slow = setTimeout(() => ctl.abort(new Error("timed out（太慢）")), this.slow * 1000);
    arm();
    try {
      const r = await this.fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: ctl.signal, credentials: "omit", cache: "no-store" });
      if (r.status !== 206) {
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      const buf = new Uint8Array(end - start);
      let n = 0;
      const rd = r.body.getReader();
      for (;;) {
        arm();
        const { done, value } = await rd.read();
        if (done) break;
        if (n + value.length > buf.length) throw new Error("返回的数据比请求的多");
        buf.set(value, n);
        n += value.length;
      }
      if (n !== buf.length) throw new Error(`short read ${n}/${buf.length}`);
      return buf;
    } catch (err) {
      throw ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err;
    } finally {
      clearTimeout(stall);
      clearTimeout(slow);
    }
  }

  async refreshLinks(t) {
    if (this.now() - this.refreshed[t] < REFRESH_MIN) return;
    this.refreshed[t] = this.now();
    try {
      this.streams[t] = await this.refresh(t);
      this.log("链接已刷新");
    } catch (err) {
      this.log("刷新链接失败：" + (err.message || err));
    }
  }
}
