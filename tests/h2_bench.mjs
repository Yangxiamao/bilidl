// 纯插件方案的前提：CDN 是按 TCP 连接限速，还是按 HTTP/2 stream（单个请求）限速？
// 浏览器对同一域名只开一条 HTTP/2 连接，所以只有按 stream 限速时，页面里并发请求才能提速（见 docs/EXTENSION_ONLY.md）。
// 用法: node tests/h2_bench.mjs [BV号] [每组秒数] [节点,节点…]
// 流量：约 速度 × 秒数 × 组数，默认几百 MB。
import http2 from "node:http2";
import https from "node:https";
import dns from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BVID = process.argv[2] || "BV1bE41127s6";  // 约 2.5 小时的 4K 演唱会，和 play_bench.py 一样
const SEC = Number(process.argv[3] || 8);
const MB = 1 << 20;
const HEADERS = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
                  referer: "https://www.bilibili.com/", origin: "https://www.bilibili.com" };

// 用 bilidl 取一个真实的视频流链接（4K 时文件大，测 8 秒不会读到末尾）
export function streamInfo(bvid) {
  const py = `import sys, json; sys.path.insert(0, sys.argv[1]); import bilidl
api = bilidl.Api(); _, _, pages = bilidl.video_meta(api, sys.argv[2])
dash = bilidl.playurl(api, sys.argv[2], pages[0][2])["dash"]
v, a = bilidl.pick_streams(dash, 120)
print(json.dumps({"video": [v.get("baseUrl")] + (v.get("backupUrl") or []), "audio": a and a.get("baseUrl"),
                  "qn": v["id"], "bandwidth": v["bandwidth"], "duration": dash["duration"], "fast": bilidl.FAST_HOSTS}))`;
  return JSON.parse(execFileSync("python", ["-I", "-c", py, ROOT, bvid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

export function onHost(url, host) {
  const u = new URL(url);
  u.hostname = host;
  return u.href;
}

// 一条 HTTP/2 连接上同时跑 streams 个请求循环，每个请求 1 MB Range，持续 sec 秒
async function h2Run(url, streams, sec, conns = 1) {
  const u = new URL(url);
  const sessions = await Promise.all(Array.from({ length: conns }, () => new Promise((ok, bad) => {
    // Node 默认流控窗口只有 64 KB，高延迟下会把速度压在 0.5 MB/s 左右；按 Chrome 的设置放大（stream 6 MB，连接 15 MB）
    const s = http2.connect(u.origin, { settings: { initialWindowSize: 6 * MB } });
    s.once("connect", () => { s.setLocalWindowSize(15 * MB); ok(s); });
    s.once("error", bad);
  })));
  const alpn = sessions[0].alpnProtocol;
  let bytes = 0, reqs = 0, errs = 0, altSvc = "";
  const deadline = Date.now() + sec * 1000;
  let offset = 0;
  const one = s => new Promise(ok => {
    const start = offset; offset += MB;
    const req = s.request({ ":path": u.pathname + u.search, range: `bytes=${start}-${start + MB - 1}`, ...HEADERS });
    req.setTimeout(10000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", h => { altSvc ||= h["alt-svc"] || ""; if (h[":status"] !== 206) errs++; });
    req.on("data", c => { if (Date.now() < deadline) bytes += c.length; });
    req.on("end", () => { reqs++; ok(); });
    req.on("error", () => { errs++; ok(); });
    req.on("close", ok);
  });
  const loop = async s => { while (Date.now() < deadline) await one(s); };
  const t0 = Date.now();
  await Promise.race([Promise.all(sessions.flatMap(s => Array.from({ length: streams }, () => loop(s)))),
                      new Promise(r => setTimeout(r, sec * 1000 + 1000))]);
  const t = Math.min(Date.now() - t0, sec * 1000) / 1000;
  sessions.forEach(s => s.destroy());
  return { mbps: bytes / MB / t, reqs, errs, alpn, altSvc };
}

// 对照组：每个线程一条独立的 HTTP/1.1 连接（和 Python 下载器一样）
async function h1Run(url, conns, sec) {
  const u = new URL(url);
  let bytes = 0, reqs = 0, errs = 0, offset = 0;
  const deadline = Date.now() + sec * 1000;
  const loop = async () => {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    while (Date.now() < deadline) {
      await new Promise(ok => {
        const start = offset; offset += MB;
        const req = https.get(u, { agent, headers: { ...HEADERS, range: `bytes=${start}-${start + MB - 1}` }, timeout: 10000 }, r => {
          if (r.statusCode !== 206) errs++;
          r.on("data", c => { if (Date.now() < deadline) bytes += c.length; });
          r.on("end", () => { reqs++; ok(); });
          r.on("error", () => { errs++; ok(); });
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => { errs++; ok(); });
      });
    }
    agent.destroy();
  };
  const t0 = Date.now();
  await Promise.race([Promise.all(Array.from({ length: conns }, loop)), new Promise(r => setTimeout(r, sec * 1000 + 1000))]);
  return { mbps: bytes / MB / (Math.min(Date.now() - t0, sec * 1000) / 1000), reqs, errs };
}

async function main() {
  const info = streamInfo(BVID);
  const hosts = process.argv[4] ? process.argv[4].split(",") : info.fast.slice(0, 3);
  console.log(`${BVID} qn=${info.qn} 码率 ${(info.bandwidth / 8 / MB).toFixed(2)} MB/s，每组 ${SEC} 秒`);

  console.log("\n## 节点解析到的 IP（同一组 IP + 通配证书时，Chrome 会把不同域名合并到一条连接）");
  for (const h of info.fast) {
    try { console.log(h.padEnd(36), (await dns.lookup(h, { all: true, family: 4 })).map(x => x.address).sort().join(" ")); } catch (e) { console.log(h.padEnd(36), "解析失败", e.code); }
  }

  const base = info.video.find(x => new URL(x).hostname.startsWith("upos-") && x.includes(".bilivideo.com")) || info.video[0];
  for (const h of hosts) {
    const url = onHost(base, h);
    console.log(`\n## ${h}`);
    const rows = [];
    for (const [name, fn] of [
      ["A  1 连接 × 1 stream", () => h2Run(url, 1, SEC)],
      ["B4 1 连接 × 4 stream", () => h2Run(url, 4, SEC)],
      ["B16 1 连接 × 16 stream", () => h2Run(url, 16, SEC)],
      ["C4 4 条 HTTP/1.1 连接", () => h1Run(url, 4, SEC)],
      ["C16 16 条 HTTP/1.1 连接", () => h1Run(url, 16, SEC)],
      ["D 4 条 h2 连接 × 4 stream", () => h2Run(url, 4, SEC, 4)],
    ]) {
      try {
        const r = await fn();
        rows.push(r);
        console.log(name.padEnd(28), `${r.mbps.toFixed(2).padStart(6)} MB/s  请求 ${r.reqs}  错误 ${r.errs}`
          + (r.alpn ? `  alpn=${r.alpn}` : "") + (r.altSvc ? `  alt-svc=${r.altSvc}` : ""));
      } catch (e) {
        console.log(name.padEnd(28), "失败", e.code || e.message);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
