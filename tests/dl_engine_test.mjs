// 下载插件的下载引擎（extension-dl/src/download.js）离线测试：用本地的 m4s 样本模拟 CDN，几个节点表现各不相同：
//   fast 正常；slow 很慢；stall 返回响应头后就不再给数据；flaky 一半请求出错；签名在第 N 个请求后过期（403），刷新链接后恢复。
// 中途取消一次再续传（模拟暂停 / 关掉浏览器），最后用 ffmpeg 比较每个流的 packet 数据哈希和 ffmpeg -c copy 的参考输出。
// 用法: node tests/dl_engine_test.mjs <样本目录> [名字，默认 avc4k]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseHead, layout, finish } from "../extension-dl/src/mux.js";
import { Download, chunkCounts } from "../extension-dl/src/download.js";

const [DIR, NAME = "avc4k"] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inputs = ["video", "audio"].map(k => fs.readFileSync(path.join(DIR, `${NAME}.${k}.m4s`)));
const tracks = inputs.map(b => parseHead(new Uint8Array(b.buffer, b.byteOffset, Math.min(b.length, 1 << 20))));
tracks[0].fps = 62.5;
const lay = layout(tracks);
const out = path.join(DIR, `${NAME}.engine.out.mp4`);
const fd = fs.openSync(out, "w+");
fs.ftruncateSync(fd, lay.size);
fs.writeSync(fd, lay.header, 0, lay.header.length, 0);

// ---------- 假 CDN ----------
let sig = 1, reqs = 0;
const EXPIRE_AT = 150;  // 第 150 个请求起旧签名失效
const stat = {};
async function fakeFetch(url, { headers, signal }) {
  const u = new URL(url), host = u.hostname.split(".")[0], t = +u.pathname.split("/")[1];
  stat[host] = (stat[host] || 0) + 1;
  if (++reqs === EXPIRE_AT) sig++;
  if (+u.searchParams.get("sig") !== sig) return { status: 403 };
  const [a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range).slice(1).map(Number);
  const data = inputs[t].subarray(a, b + 1);
  if (host === "flaky" && Math.random() < 0.5) throw new TypeError("Failed to fetch");
  const pieces = host === "slow" ? 8 : 2, delay = host === "slow" ? 150 : 5;
  let i = 0;
  const body = { getReader: () => ({
    read: async () => {
      if (host === "stall" && i === 1) await new Promise((_, bad) => signal.addEventListener("abort", () => bad(signal.reason)));
      if (i >= pieces) return { done: true };
      await sleep(delay);
      signal.throwIfAborted();
      const len = Math.ceil(data.length / pieces);
      return { done: false, value: data.subarray(i * len, Math.min(data.length, ++i * len)) };
    },
  }) };
  await sleep(delay);
  return { status: 206, body };
}
const linksFor = t => {
  const urls = ["fast", "slow", "stall", "flaky"].map(h => `https://${h}.test/${t}/x.m4s?sig=${sig}`);
  return { tmpl: null, urls };
};

const done = chunkCounts(lay).map(n => new Uint8Array(n));
let refreshes = 0;
const opts = () => ({
  lay, done, streams: [0, 1].map(linksFor), refresh: async t => { refreshes++; return linksFor(t); },
  write: (pos, data) => { fs.writeSync(fd, data, 0, data.length, pos); }, fetch: fakeFetch, workers: 16,
  stall: 1, slow: 4, hedgeAfter: 0.5, log: m => console.log("   ", m),
});

let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`); };

// 第一轮：下到 40% 左右取消
const d1 = new Download(opts());
const ctl = new AbortController();
const t0 = Date.now();
const iv = setInterval(() => { const p = d1.progress(); if (p.done > p.total * 0.4) ctl.abort(new Error("暂停")); }, 50);
let r1;
try { await d1.run(ctl.signal); r1 = "下完了"; } catch (e) { r1 = e.message; }
clearInterval(iv);
await sleep(100);
const half = done.map(b => b.reduce((s, x) => s + x, 0));
check("第一轮被取消", r1 === "暂停", `${r1}，已完成 ${half.join("+")} 段`);

// 第二轮：从进度位图续传
const d2 = new Download(opts());
check("续传时跳过已完成的段", d2.todo.length === done.reduce((s, b) => s + b.length, 0) - half[0] - half[1], `剩 ${d2.todo.length} 段`);
await d2.run();
const p = d2.progress();
check("全部下完", done.every(b => b.every(x => x === 1)) && p.done === p.total);
check("签名过期后刷新了链接", refreshes >= 1 && refreshes <= 4, `刷新 ${refreshes} 次`);
console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，各节点请求数`, stat, "第二轮命中", p.hosts);
const hits = h => p.hosts[h + ".test"] || 0;
check("快节点拿到的分段最多", hits("fast") > hits("slow") && hits("fast") > hits("flaky") && hits("fast") > hits("stall"),
  `fast ${hits("fast")}，slow ${hits("slow")}，flaky ${hits("flaky")}，stall ${hits("stall")}`);

const fin = await finish(lay, (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return new Uint8Array(b.buffer, b.byteOffset, len); });
for (const [pos, data] of fin.writes) fs.writeSync(fd, data, 0, data.length, pos);
fs.ftruncateSync(fd, fin.size);
fs.closeSync(fd);
const hash = f => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"], { encoding: "utf8" }).trim();
check("和 ffmpeg -c copy 的 packet 数据哈希一致", hash(out) === hash(path.join(DIR, `${NAME}.ref.mp4`)));
fs.rmSync(out);
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
