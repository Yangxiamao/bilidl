// 在真实 Chrome 里验证纯插件方案的两个前提（见 docs/EXTENSION_ONLY.md）：
//   1. 从 bilibili.com 页面里并发 fetch 视频分段，总速度能否随并发数增长（实际用了几条连接）；
//   2. 播放器从哪里取视频分段（主线程 XHR / Worker），在页面脚本运行前 hook 能不能接管这些请求，且视频照常播放。
// 用临时 profile 启动无头 Chrome，游客身份，不碰用户自己的 Chrome 数据。
// 用法: node tests/chrome_spike.mjs [BV号] [每组秒数] [--takeover]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamInfo, onHost } from "./h2_bench.mjs";

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const BVID = args[0] || "BV1bE41127s6";
const SEC = Number(args[1] || 8);
const TAKEOVER = process.argv.includes("--takeover");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 页面脚本运行前执行（相当于插件 MAIN world、document_start 的内容脚本）：
//   - 记录播放器有没有建 Worker、XHR/fetch 里有多少 m4s 请求；
//   - TAKEOVER 时接管 upos 上的 m4s XHR：同一段 Range 拆成 4 份并发取（换到 FAST 节点），拼好后交还给播放器；
//     出错就改发原请求（相当于退回直连）。
function pageHook(takeover, fast) {
  const st = window.__spike = { workers: [], xhr: 0, m4s: 0, fetchM4s: 0, served: 0, fallback: 0, bytes: 0, ms: 0, errs: [] };
  const OrigWorker = window.Worker;
  window.Worker = function (url, opts) { st.workers.push(String(url).slice(0, 160)); return new OrigWorker(url, opts); };
  window.Worker.prototype = OrigWorker.prototype;
  const f = window.fetch;
  window.fetch = function (i) { if (/\.m4s/.test(String((i && i.url) || i))) st.fetchM4s++; return f.apply(this, arguments); };

  const X = window.XMLHttpRequest;
  const fake = (xhr, props) => { for (const k in props) Object.defineProperty(xhr, k, { configurable: true, get: () => props[k] }); };
  const fire = (xhr, type, init) => xhr.dispatchEvent(init ? new ProgressEvent(type, init) : new Event(type));
  async function grab(url, a, b, signal) {
    const u = new URL(url); u.hostname = fast;
    const n = Math.max(1, Math.min(4, Math.floor((b - a + 1) / (256 << 10))));
    const step = Math.ceil((b - a + 1) / n);
    const parts = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const s = a + i * step, e = Math.min(b, s + step - 1);
      const r = await f(u.href, { headers: { Range: "bytes=" + s + "-" + e }, signal });
      if (r.status !== 206) throw new Error("HTTP " + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length !== e - s + 1) throw new Error("长度不对 " + buf.length);
      return { buf, total: r.headers.get("Content-Range").split("/")[1] };
    }));
    const out = new Uint8Array(b - a + 1);
    let o = 0;
    for (const p of parts) { out.set(p.buf, o); o += p.buf.length; }
    return { data: out.buffer, total: parts[0].total };
  }
  class HX extends X {
    open(m, u) { this.__u = String(u); this.__range = null; st.xhr++; if (/\.m4s/.test(this.__u)) st.m4s++; return super.open(...arguments); }
    setRequestHeader(k, v) { if (k.toLowerCase() === "range") this.__range = v; return super.setRequestHeader(k, v); }
    abort() { if (this.__ctl) { this.__ctl.abort(); this.__ctl = null; fake(this, { readyState: 4, status: 0 }); fire(this, "abort"); fire(this, "loadend"); return; } return super.abort(); }
    send(body) {
      const m = takeover && /^https:\/\/upos-[^/]+\/[^?]*\.m4s/.test(this.__u) && /^bytes=(\d+)-(\d+)$/.exec(this.__range || "");
      if (!m || this.responseType !== "arraybuffer") return super.send(body);
      const a = +m[1], b = +m[2], t0 = performance.now(), ctl = this.__ctl = new AbortController();
      grab(this.__u, a, b, ctl.signal).then(({ data, total }) => {
        if (this.__ctl !== ctl) return;
        this.__ctl = null;
        st.served++; st.bytes += data.byteLength; st.ms += performance.now() - t0;
        const hdr = { "content-range": "bytes " + a + "-" + b + "/" + total, "content-length": String(data.byteLength), "content-type": "video/mp4" };
        fake(this, { readyState: 4, status: 206, statusText: "Partial Content", response: data, responseURL: this.__u });
        this.getResponseHeader = k => hdr[String(k).toLowerCase()] ?? null;
        this.getAllResponseHeaders = () => Object.entries(hdr).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n";
        fire(this, "readystatechange");
        fire(this, "progress", { lengthComputable: true, loaded: data.byteLength, total: data.byteLength });
        fire(this, "load", { lengthComputable: true, loaded: data.byteLength, total: data.byteLength });
        fire(this, "loadend", { lengthComputable: true, loaded: data.byteLength, total: data.byteLength });
      }, e => {
        if (this.__ctl !== ctl) return;
        this.__ctl = null;
        st.fallback++; if (st.errs.length < 5) st.errs.push(String(e));
        super.send(body);
      });
    }
  }
  window.XMLHttpRequest = HX;
}
const hookJs = (takeover, fast) => `(${pageHook})(${takeover}, ${JSON.stringify(fast)});`;

// 在页面里跑：n 个并发循环，每个请求 1 MB Range，轮流用 urls 里的节点
const BENCH_JS = `async (urls, n, sec) => {
  const MB = 1 << 20, end = performance.now() + sec * 1000;
  let bytes = 0, off = 0, reqs = 0, errs = 0;
  async function loop(i) {
    while (performance.now() < end) {
      const s = off; off += MB;
      try {
        const r = await fetch(urls[(i + reqs) % urls.length], { headers: { Range: "bytes=" + s + "-" + (s + MB - 1) }, cache: "no-store" });
        if (r.status !== 206) errs++;
        const rd = r.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          if (performance.now() >= end) { rd.cancel(); break; }
          bytes += value.length;
        }
        reqs++;
      } catch (e) { errs++; }
    }
  }
  const t0 = performance.now();
  await Promise.all(Array.from({ length: n }, (_, i) => loop(i)));
  return { mbps: bytes / MB / ((Math.min(performance.now(), end) - t0) / 1000), reqs, errs };
}`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { ok, bad } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? bad(new Error(m.error.message)) : ok(m.result);
      } else this.handlers.forEach(h => h(m));
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, bad) => this.pending.set(id, { ok, bad }));
  }
  on(h) { this.handlers.push(h); }
}

async function evaluate(cdp, sid, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function main() {
  const info = streamInfo(BVID);
  const base = info.video.find(x => new URL(x).hostname.startsWith("upos-") && x.includes(".bilivideo.com")) || info.video[0];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bilidl-spike-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--mute-audio", `--user-agent=${UA}`,
    "about:blank"], { stdio: "ignore" });
  try {
    let ver;
    for (let i = 0; i < 50 && !ver; i++) {
      await sleep(200);
      ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json(), () => null);
    }
    console.log("Chrome", ver.Browser, TAKEOVER ? "（接管播放器的 m4s 请求）" : "（只统计，不接管）");
    const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    const conns = new Map();  // host -> Map(connectionId -> 协议)
    const workers = [];
    const initiators = new Map();  // "类型 发起位置" -> 次数
    cdp.on(m => {
      if (m.method === "Network.requestWillBeSent" && /\.m4s/.test(m.params.request.url) && m.sessionId === sid) {
        const fr = m.params.initiator.stack?.callFrames?.[0];
        const k = `${m.params.type} ${m.params.initiator.type} ${fr ? fr.url.slice(0, 90) : ""}`;
        initiators.set(k, (initiators.get(k) || 0) + 1);
      }
      if (m.method === "Network.responseReceived" && /\.m4s/.test(m.params.response.url)) {
        const r = m.params.response, h = new URL(r.url).hostname;
        if (!conns.has(h)) conns.set(h, new Map());
        conns.get(h).set(r.connectionId, r.protocol);
      }
      if (m.method === "Target.attachedToTarget" && /worker/.test(m.params.targetInfo.type)) {
        workers.push({ sid: m.params.sessionId, type: m.params.targetInfo.type, url: m.params.targetInfo.url });
        cdp.send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {});
      }
    });
    await cdp.send("Network.enable", {}, sid);
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: hookJs(TAKEOVER, info.fast[1]) }, sid);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
    await cdp.send("Page.navigate", { url: `https://www.bilibili.com/video/${BVID}` }, sid);

    console.log("\n## 播放器 Worker 和播放状态（打开页面 25 秒后）");
    await sleep(25000);
    const page = await evaluate(cdp, sid, `(() => { const v = document.querySelector("video");
      return { href: location.href, spike: window.__spike,
               video: v && { t: +v.currentTime.toFixed(1), paused: v.paused, buffered: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(1) : 0, err: v.error && v.error.code } }; })()`);
    console.log(JSON.stringify(page, null, 1));
    for (const w of workers) console.log("worker", w.type, w.url.slice(0, 120));
    console.log("m4s 请求的发起方:", JSON.stringify([...initiators], null, 1));
    const player = [...conns].map(([h, m]) => `${h}: ${m.size} 条连接 ${[...new Set(m.values())].join("/")}`);
    console.log("播放器的 m4s 请求:", player.join("; ") || "没有");

    console.log("\n## 在页面里并发 fetch（先暂停视频）");
    await evaluate(cdp, sid, `document.querySelector("video")?.pause()`);
    conns.clear();
    const hosts = info.fast.slice(0, 3);
    const runs = [[hosts[1], 1], [hosts[1], 4], [hosts[1], 16], ["3 个节点", 16]];
    for (const [label, n] of runs) {
      const urls = label === "3 个节点" ? hosts.map(h => onHost(base, h)) : [onHost(base, label)];
      const r = await evaluate(cdp, sid, `(${BENCH_JS})(${JSON.stringify(urls)}, ${n}, ${SEC})`);
      console.log(`${label.padEnd(34)} 并发 ${String(n).padStart(2)}: ${r.mbps.toFixed(2).padStart(6)} MB/s  请求 ${r.reqs}  错误 ${r.errs}`);
    }
    console.log("测试期间的连接:", [...conns].map(([h, m]) => `${h}: ${m.size} 条 ${[...new Set(m.values())].join("/")}`).join("; "));
  } finally {
    chrome.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
