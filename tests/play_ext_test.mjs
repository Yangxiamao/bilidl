// 播放加速插件（extension-play/）的端到端验收：用临时 profile 启动无头 Chrome，加载打包好的插件，打开真实的 B 站视频页。
//   correct：在页面里用 XHR 发各种 Range，接管返回的数据和直连逐字节比较；认不出的请求原样放行；插件的 fetch 全部失败时退回直连。
//   bench：  在页面里按 tests/play_bench.py 的模型模拟播放器（1x → 2x → 跳到 60% → 3x），比较插件关闭（直连）和开启时的卡顿。
//   player： 真实播放器按同样的四个阶段改倍速、跳转，按 waiting 事件统计卡顿，开启和关闭各一次。
// 会把仓库根目录 sessdata.txt 里的登录 cookie 写进临时 profile（测完连同 profile 删掉），好拿到 4K。
// 用法: node tests/play_ext_test.mjs [correct|bench|player|all] [BV号] [档位 low|mid|high] [--only-on]
// 品牌版 Chrome 137 起不支持 --load-extension，这里用 --remote-debugging-pipe + Extensions.loadUnpacked。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamInfo } from "./h2_bench.mjs";
import { build } from "../tools/build_ext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const MODE = args[0] || "all";
const BVID = args[1] || "BV1bE41127s6";  // 约 2.5 小时的 4K 演唱会，和 play_bench.py 一样
const PROFILE = args[2] || "mid";
const ONLY_ON = process.argv.includes("--only-on");
const VERBOSE = process.argv.includes("--verbose");  // bench 时每 2 秒打印一次插件状态
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const MB = 1 << 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// (说明, 倍速, 时长秒, 跳转到的比例或 null)，和 play_bench.py 一样
const PHASES = [["1x", 1, 25, null], ["切到 2x", 2, 30, null], ["跳到 60% 后 2x", 2, 25, 0.6], ["切到 3x", 3, 25, null]];

// ---------- CDP（走 --remote-debugging-pipe：fd 3 写命令，fd 4 读结果，消息以 \0 分隔） ----------
class CDP {
  constructor(child) {
    this.w = child.stdio[3];
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    let buf = "";
    child.stdio[4].on("data", d => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.id && this.pending.has(m.id)) {
          const { ok, bad, method } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? bad(new Error(`${method}: ${m.error.message}`)) : ok(m.result);
        } else this.handlers.forEach(h => h(m));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.w.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    return new Promise((ok, bad) => this.pending.set(id, { ok, bad, method }));
  }
  on(h) { this.handlers.push(h); }
}

export async function evaluate(cdp, sid, expr, timeout = 600000) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// 页面里向 page.js 要一份状态（和 bridge.js 用的是同一个事件）
export const STATS_JS = `new Promise(ok => {
  const id = "t" + Math.random();
  const h = e => { const s = JSON.parse(e.detail); if (s.id === id) { document.removeEventListener("bilidl-play:stats", h); ok(s); } };
  document.addEventListener("bilidl-play:stats", h);
  document.dispatchEvent(new CustomEvent("bilidl-play:get", { detail: id }));
  setTimeout(() => ok(null), 2000);
})`;

export class Browser {
  async start() {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), "bilidl-play-"));
    this.child = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
      `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", `--user-agent=${UA}`, "about:blank"],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    process.on("exit", () => this.child.kill());  // 中途出错或被停掉时也别留下还在播放的 Chrome
    this.cdp = new CDP(this.child);
    const ver = await this.cdp.send("Browser.getVersion");
    this.extId = (await this.cdp.send("Extensions.loadUnpacked", { path: await build() })).id;
    console.log(ver.product, "插件", this.extId);
    const sess = fs.existsSync(path.join(ROOT, "sessdata.txt")) && fs.readFileSync(path.join(ROOT, "sessdata.txt"), "utf8").trim();
    if (sess) await this.cdp.send("Storage.setCookies", { cookies: [{ name: "SESSDATA", value: sess, domain: ".bilibili.com",
      path: "/", secure: true, httpOnly: true, expires: Date.now() / 1000 + 86400 }] });
    else console.log("没有 sessdata.txt，以游客身份测试（拿不到 4K）");
    // 一个插件页面，用来改设置（和弹出页一样写 chrome.storage.local）
    const { targetId } = await this.cdp.send("Target.createTarget", { url: `chrome-extension://${this.extId}/popup.html` });
    this.extSid = (await this.cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await sleep(500);
    await this.config({ playEnabled: true, playProfile: PROFILE });
  }

  config(c) {
    return evaluate(this.cdp, this.extSid, `chrome.storage.local.set(${JSON.stringify(c)})`);
  }

  /** 新开一个标签页打开 url，返回 sessionId。网络事件里记下播放器自己发出的 upos m4s XHR（被接管的不会出现在网络里）。 */
  async open(url) {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    const sid = (await this.cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const net = { xhr: 0, fetch: 0, hosts: new Set() };
    this.cdp.on(m => {
      if (m.sessionId !== sid || m.method !== "Network.requestWillBeSent") return;
      const u = m.params.request.url;
      if (!/^https:\/\/upos-[^/]+\/[^?]*\.m4s/.test(u)) return;
      if (m.params.type === "XHR") net.xhr++;
      if (m.params.type === "Fetch") { net.fetch++; net.hosts.add(new URL(u).hostname); }
    });
    await this.cdp.send("Network.enable", {}, sid);
    await this.cdp.send("Page.enable", {}, sid);
    await this.cdp.send("Page.navigate", { url }, sid);
    return { sid, targetId, net };
  }

  close(targetId) {
    return this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }

  async stop() {
    this.child.kill();
    await sleep(800);
    fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

// ---------- correct ----------
// 页面里：用（被接管的）XHR 取一段，和原生 fetch 直连取的比较。返回状态码、长度、SHA-256，以及是否被接管（实例上有伪造的属性）
const XHR_JS = `async (url, range, rt, abortAtHeaders) => {
  const x = new XMLHttpRequest();
  const done = new Promise(ok => {
    x.onreadystatechange = () => { if (abortAtHeaders && x.readyState >= 2 && x.readyState < 4) x.abort(); };
    x.onloadend = ok;
  });
  x.open("GET", url);
  x.responseType = rt;
  if (range) x.setRequestHeader("Range", range);
  x.send();
  await done;
  const taken = Object.prototype.hasOwnProperty.call(x, "response");
  if (abortAtHeaders || rt !== "arraybuffer") return { status: x.status, taken };
  const buf = x.response || new ArrayBuffer(0);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
  return { status: x.status, len: buf.byteLength, hash, taken, cr: x.getResponseHeader("Content-Range") };
}`;
const DIRECT_JS = `async (url, range) => {
  const r = await fetch(url, { headers: { Range: range }, cache: "no-store" });
  const buf = await r.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
  return { status: r.status, len: buf.byteLength, hash, cr: r.headers.get("Content-Range") };
}`;

async function correct(b, info) {
  console.log("\n## 正确性");
  const { sid, targetId } = await b.open(`https://www.bilibili.com/video/${BVID}`);
  await sleep(6000);
  await evaluate(b.cdp, sid, `document.querySelector("video")?.pause()`);
  const st0 = await evaluate(b.cdp, sid, STATS_JS);
  if (!st0) throw new Error("页面里没有插件（page.js 没注入）");
  const vurl = info.video[0], aurl = info.audio;
  const size = Number((await evaluate(b.cdp, sid, `(${DIRECT_JS})(${JSON.stringify(vurl)}, "bytes=0-0")`)).cr.split("/")[1]);
  console.log(`视频 ${(size / 1e9).toFixed(2)} GB，原始节点 ${new URL(vurl).hostname}`);
  const C = MB;
  const cases = [["初始化段", vurl, 0, 999], ["跨块", vurl, C - 10, C + 10], ["不对齐、跨三块", vurl, 5, 2 * C + 100],
                 ["4K 一个分段大小（约 6 MB）", vurl, 50 * C + 777, 56 * C], ["文件最后 1000 字节", vurl, size - 1000, size - 1],
                 ["超出文件末尾（截断）", vurl, size - 10, size + 5000], ["完全超出文件（416）", vurl, size + 10, size + 20],
                 ["音频", aurl, 1000, 300000]];
  const akam = info.video.find(u => new URL(u).hostname.endsWith(".akamaized.net"));
  if (akam) cases.push(["只给 akamai 链接", akam, 3 * C, 4 * C + 5]);
  let bad = 0;
  const check = (ok, msg) => { if (!ok) bad++; console.log(ok ? "  通过" : "  失败", msg); };
  for (const [name, u, a, z] of cases) {
    const range = `bytes=${a}-${z}`;
    const [got, want] = await Promise.all([evaluate(b.cdp, sid, `(${XHR_JS})(${JSON.stringify(u)}, ${JSON.stringify(range)}, "arraybuffer")`),
                                           evaluate(b.cdp, sid, `(${DIRECT_JS})(${JSON.stringify(u)}, ${JSON.stringify(range)})`)]);
    const same = got.status === want.status && (want.status !== 206 || (got.len === want.len && got.hash === want.hash));
    check(same && (want.status === 206 ? got.taken : !got.taken),
          `${name}：${got.status} ${got.len ?? ""} 字节，${got.taken ? "接管" : "直连"}；直连 ${want.status} ${want.len} 字节`);
  }
  // 8 个请求落在同一个没拉过的块上
  const same8 = await evaluate(b.cdp, sid, `Promise.all(Array.from({ length: 8 }, (_, i) =>
    (${XHR_JS})(${JSON.stringify(vurl)}, "bytes=" + (${80 * C} + i * 1000) + "-" + (${80 * C} + i * 1000 + 99999), "arraybuffer")))`);
  const want8 = await evaluate(b.cdp, sid, `Promise.all(Array.from({ length: 8 }, (_, i) =>
    (${DIRECT_JS})(${JSON.stringify(vurl)}, "bytes=" + (${80 * C} + i * 1000) + "-" + (${80 * C} + i * 1000 + 99999))))`);
  check(same8.every((g, i) => g.taken && g.hash === want8[i].hash), "8 个并发请求落在同一块，数据都正确");

  console.log("认不出的请求原样放行：");
  for (const [name, u, range, rt] of [["responseType = blob", vurl, "bytes=0-999", "blob"], ["没有 Range", vurl, null, "arraybuffer"],
                                      ["开放区间 bytes=N-", vurl, "bytes=100-", "arraybuffer"]]) {
    const r = await evaluate(b.cdp, sid, `(${XHR_JS})(${JSON.stringify(u)}, ${JSON.stringify(range)}, ${JSON.stringify(rt)}, true)`);
    check(!r.taken, `${name}：${r.taken ? "被接管了" : "直连"}`);
  }

  console.log("插件的 fetch 全部失败时退回直连：");
  // CDP 的 Fetch 拦截把页面里的 fetch 也算成 XHR，分不开；插件拉的都是按 1 MB 对齐的块，测试请求故意不对齐，按这个区分
  const failer = m => {
    if (m.sessionId !== sid || m.method !== "Fetch.requestPaused") return;
    const r = /bytes=(\d+)-/.exec(Object.entries(m.params.request.headers).find(([k]) => k.toLowerCase() === "range")?.[1] || "");
    const p = { requestId: m.params.requestId };
    (r && +r[1] % C === 0 ? b.cdp.send("Fetch.failRequest", { ...p, errorReason: "Failed" }, sid)
                          : b.cdp.send("Fetch.continueRequest", p, sid)).catch(() => {});
  };
  b.cdp.on(failer);
  await b.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*.m4s*" }] }, sid);
  const before = (await evaluate(b.cdp, sid, STATS_JS)).counts.fallback;
  const range = `bytes=${200 * C + 3}-${201 * C + 500}`;
  const got = await evaluate(b.cdp, sid, `(${XHR_JS})(${JSON.stringify(vurl)}, ${JSON.stringify(range)}, "arraybuffer")`);
  await b.cdp.send("Fetch.disable", {}, sid);
  b.cdp.handlers = b.cdp.handlers.filter(h => h !== failer);
  const want = await evaluate(b.cdp, sid, `(${DIRECT_JS})(${JSON.stringify(vurl)}, ${JSON.stringify(range)})`);
  const stF = await evaluate(b.cdp, sid, STATS_JS), after = stF.counts.fallback;
  if (got.hash !== want.hash) console.log("  记录:", stF.logs.slice(-3).join(" | "));
  check(!got.taken && got.hash === want.hash && after >= before + 1,  // 后台的播放器这时也可能有请求退回直连
        `退回直连 ${after - before} 次，数据${got.hash === want.hash ? "一致" : "不一致"}（${got.status} ${got.len} 字节，直连 ${want.status} ${want.len} 字节）`);
  await b.close(targetId);
  return bad;
}

// ---------- bench：页面里的模拟播放器（模型同 play_bench.py） ----------
const SIM_JS = `async (url, size, bps, phases, withStats) => {
  const BUFFER_SEC = 72, SEG_SEC = 2, START_SEC = 2, RESUME_SEC = 1, CHUNK = ${MB};
  const s = { play: 0, fetch: 0, speed: 1, playing: false, stallT0: null, stop: false };
  let cur, tStart = performance.now() / 1000;
  const now = () => performance.now() / 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getStats = () => ${STATS_JS};
  const get = (a, b) => new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.responseType = "arraybuffer";
    x.setRequestHeader("Range", "bytes=" + a + "-" + b);
    x.onload = () => x.status === 206 ? ok(x.response) : bad(new Error("HTTP " + x.status));
    x.onerror = () => bad(new Error("网络错误"));
    x.ontimeout = () => bad(new Error("超时"));
    x.send();
  });
  (async () => {
    while (!s.stop) {
      const buf = (s.fetch - s.play) / bps, pos = s.fetch;
      if (buf >= BUFFER_SEC || pos >= size) { await sleep(50); continue; }
      const end = Math.min(pos + Math.floor(SEG_SEC * bps), size) - 1;
      const t0 = now();
      try {
        const data = await get(pos, end);
        if (s.fetch === pos) { s.fetch = pos + data.byteLength; cur.lat.push(now() - t0); cur.bytes += data.byteLength; }
      } catch (e) { cur.errors++; await sleep(500); }
    }
  })();
  const out = [];
  for (const [desc, speed, dur, seek] of phases) {
    cur = { desc, speed, dur, stalls: 0, stallTime: 0, lat: [], bytes: 0, errors: 0, ahead: [], startup: null };
    const tPhase = now();
    s.speed = speed;
    if (seek != null) {
      const p = Math.floor(size * seek / CHUNK) * CHUNK + 12345;
      Object.assign(s, { play: p, fetch: p, playing: false, stallT0: null });
      tStart = now();
    }
    let last = now(), nextStat = now() + 2;
    while (now() - tPhase < dur) {
      await sleep(50);
      const t = now(), buf = (s.fetch - s.play) / bps;
      if (!s.playing) {
        if (buf >= (s.stallT0 == null ? START_SEC : RESUME_SEC) || s.fetch >= size) {
          if (s.stallT0 != null) cur.stallTime += t - s.stallT0;
          else if (cur.startup == null) cur.startup = t - tStart;
          s.playing = true; s.stallT0 = null;
        }
      } else {
        s.play = Math.min(s.play + bps * speed * (t - last), s.fetch);
        if (s.play >= s.fetch && s.fetch < size) { s.playing = false; s.stallT0 = t; cur.stalls++; }
      }
      last = t;
      if (withStats && t >= nextStat) {
        nextStat = t + 2;
        const st = await getStats();
        const r = st && st.resources.find(r => url.includes(r.name));
        if (r && r.aheadSec != null) cur.ahead.push(r.aheadSec);
        if (st && r) (cur.snaps = cur.snaps || []).push([+(t - tPhase).toFixed(0), +((s.fetch - s.play) / bps).toFixed(0), r.aheadSec,
          +(r.rate / 1e6).toFixed(1), +(r.window / 1e6).toFixed(0), +(r.speed / 1e6).toFixed(1), st.active, st.activeUrgent, st.queued,
          st.hosts.map(h => h.host.replace(/^upos-[a-z]+-mirror|\.bilivideo\.com$/g, "") + ":" + (h.speed / 1e6).toFixed(1) + "/" + h.ok + "/" + h.fail).join(" ")]);
      }
    }
    if (s.stallT0 != null) { cur.stallTime += now() - Math.max(s.stallT0, tPhase); s.stallT0 = now(); }
    cur.buf = (s.fetch - s.play) / bps;
    out.push(cur);
  }
  s.stop = true;
  return out;
}`;

function report(label, phases, bps) {
  for (const c of phases) {
    const lat = c.lat.sort((x, y) => x - y);
    const p = q => lat.length ? lat[Math.min(Math.floor(lat.length * q), lat.length - 1)].toFixed(2) : "–";
    const ahead = c.ahead.length ? `，插件预读领先 ${Math.min(...c.ahead).toFixed(0)}~${Math.max(...c.ahead).toFixed(0)} 秒` : "";
    console.log(`  [${label}] ${c.desc.padEnd(12)} ${c.startup != null ? `起播 ${c.startup.toFixed(1)}s，` : ""}` +
      `卡顿 ${c.stalls} 次共 ${c.stallTime.toFixed(1)}s，取数 ${(c.bytes / c.dur / 1e6).toFixed(2)} MB/s（需要 ${(bps * c.speed / 1e6).toFixed(2)}），` +
      `请求耗时 p50 ${p(0.5)}s / p95 ${p(0.95)}s，缓冲 ${c.buf.toFixed(0)}s，出错 ${c.errors} 次${ahead}`);
    if (VERBOSE) for (const x of c.snaps || [])
      console.log(`      t=${x[0]} 缓冲 ${x[1]}s 预读 ${x[2]}s 取数 ${x[3]} MB/s 窗口 ${x[4]} MB 拉取 ${x[5]} MB/s 并发 ${x[6]}+${x[7]} 排队 ${x[8]} | ${x[9]}`);
  }
}

async function bench(b, info) {
  console.log(`\n## 模拟播放器（档位 ${PROFILE}）`);
  const url = info.video[0];  // 网页播放器用的就是 API 给的 baseUrl
  const runs = ONLY_ON ? [true] : [false, true];
  for (const on of runs) {
    await b.config({ playEnabled: on, playProfile: PROFILE });
    const { sid, targetId, net } = await b.open(`https://www.bilibili.com/video/${BVID}`);
    await sleep(6000);
    await evaluate(b.cdp, sid, `document.querySelector("video")?.pause()`);
    const head = await evaluate(b.cdp, sid, `(${DIRECT_JS})(${JSON.stringify(url)}, "bytes=0-0")`);
    const size = Number(head.cr.split("/")[1]);
    const bps = size / info.duration;
    if (on === runs[0]) console.log(`${BVID} | qn ${info.qn} | ${(size / 1e9).toFixed(2)} GB，平均码率 ${(bps / 1e6).toFixed(2)} MB/s | 原始节点 ${new URL(url).hostname}`);
    const res = await evaluate(b.cdp, sid, `(${SIM_JS})(${JSON.stringify(url)}, ${size}, ${bps}, ${JSON.stringify(PHASES)}, ${on})`);
    report(on ? "插件" : "直连", res, bps);
    if (on) {
      const st = await evaluate(b.cdp, sid, STATS_JS);
      console.log(`  接管 ${st.counts.served} 次，退回 ${st.counts.fallback} 次；内存 ${(st.mem / MB).toFixed(0)} MB；节点`,
        st.hosts.map(h => `${h.host.replace(/^upos-[a-z]+-|\.bilivideo\.com$/g, "")} ${(h.speed / MB).toFixed(1)}`).join(", "));
      if (st.logs.length) console.log("  记录:", st.logs.join(" | "));
    }
    await b.close(targetId);
  }
}

// ---------- player：真实播放器 ----------
const PLAYER_JS = `async (phases) => {
  const v = document.querySelector("video");
  const now = () => performance.now() / 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let cur = null, waitT0 = null;
  v.addEventListener("waiting", () => { if (cur && waitT0 == null) { waitT0 = now(); cur.stalls++; } });
  const resume = () => { if (cur && waitT0 != null) { cur.stallTime += now() - waitT0; waitT0 = null; } };
  v.addEventListener("playing", resume);
  v.addEventListener("timeupdate", () => { if (waitT0 != null && v.readyState >= 3) resume(); });
  v.muted = true;
  // 两组用同样的画质：手动选最高画质（关掉自动切换），再回到开头（登录后播放器会跳到「上次看到」的位置）
  const p = window.player, qn = p?.getSupportedQualityList?.()?.[0];
  if (qn) { p.requestQuality(qn); await sleep(6000); }
  v.currentTime = 0;
  await v.play().catch(() => {});
  await new Promise(ok => { const t = setInterval(() => { if (v.currentTime > 0.5) { clearInterval(t); ok(); } }, 200); setTimeout(ok, 20000); });
  const out = [];
  for (const [desc, speed, dur, seek] of phases) {
    cur = { desc, stalls: 0, stallTime: 0, t0: v.currentTime };
    v.playbackRate = speed;
    if (seek != null) { v.currentTime = v.duration * seek; cur.t0 = v.currentTime; cur.stalls = 0; }
    const tPhase = now();
    let bufMin = Infinity;
    while (now() - tPhase < dur) {
      await sleep(500);
      if (v.paused && !v.ended) await v.play().catch(() => {});
      let buf = 0;
      for (let i = 0; i < v.buffered.length; i++)
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.currentTime <= v.buffered.end(i)) buf = v.buffered.end(i) - v.currentTime;
      if (now() - tPhase > 5) bufMin = Math.min(bufMin, buf);
    }
    if (waitT0 != null) { cur.stallTime += now() - waitT0; waitT0 = now(); }
    cur.played = v.currentTime - cur.t0;
    cur.bufMin = bufMin;
    cur.err = v.error && v.error.code;
    cur.res = v.videoWidth + "x" + v.videoHeight;
    out.push(cur);
  }
  return { out, qn };
}`;

async function player(b) {
  console.log(`\n## 真实播放器（档位 ${PROFILE}）`);
  for (const on of ONLY_ON ? [true] : [false, true]) {
    await b.config({ playEnabled: on, playProfile: PROFILE });
    const { sid, targetId, net } = await b.open(`https://www.bilibili.com/video/${BVID}`);
    await sleep(5000);
    const { out, qn } = await evaluate(b.cdp, sid, `(${PLAYER_JS})(${JSON.stringify(PHASES)})`);
    const st = await evaluate(b.cdp, sid, STATS_JS);
    const names = st.resources.map(r => r.name.replace(/^.*-/, "")).join(", ");
    console.log(`  [${on ? "插件" : "直连"}] 选的画质 ${qn}，流 ${names || "–"}，播放器自己发的 m4s XHR ${net.xhr} 个，插件 fetch ${net.fetch} 个`,
                on ? `（接管 ${st.counts.served}，退回 ${st.counts.fallback}，未接管 ${st.counts.passed}）` : "");
    if (st.counts.passed) console.log("  未接管的请求:", st.passedSamples.join(" | "));
    for (const c of out)
      console.log(`  [${on ? "插件" : "直连"}] ${c.desc.padEnd(12)} 卡顿 ${c.stalls} 次共 ${c.stallTime.toFixed(1)}s，播放了 ${c.played.toFixed(0)} 秒，` +
                  `最少缓冲 ${isFinite(c.bufMin) ? c.bufMin.toFixed(0) : "–"} 秒，画面 ${c.res}${c.err ? `，出错 ${c.err}` : ""}`);
    await b.close(targetId);
  }
}

async function main() {
  const info = streamInfo(BVID);
  const b = new Browser();
  await b.start();
  let bad = 0;
  try {
    if (MODE === "correct" || MODE === "all") bad += await correct(b, info);
    if (MODE === "bench" || MODE === "all") await bench(b, info);
    if (MODE === "player" || MODE === "all") await player(b);
  } finally {
    await b.stop();
  }
  if (MODE === "correct" || MODE === "all") console.log(bad ? `\n正确性：${bad} 项失败` : "\n正确性：全部通过");
  process.exit(bad ? 1 : 0);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
