// 下载插件（extension-dl/）的端到端测试：临时 profile 启动无头 Chrome，加载打包好的插件，在插件页面里发起真实的下载。
//   e2e：   下载一个分P，等它存进下载目录，和 ffmpeg -c copy 的参考文件比较每个流的 packet 数据哈希（--ref 给参考文件）。
//   resume：下到 --at 比例（默认 0.4）时直接杀掉 Chrome 进程，用同一个 profile 重新启动，确认接着下（不从头）、最终文件一致。
//   speed： 下载 --secs 秒（默认 30）后删除任务，报告首字节之后的平均速度和稳态速度（和 tests/speed_bench.py 对比用）。
//   fsa：   要人配合：启动有界面的 Chrome，请你在设置页选一个保存目录，检查页面和后台 Worker 里的写权限，下载一个小视频看是否
//           写进了这个目录；正常关闭 Chrome 再启动，看授权还在不在（不在时请你点「重新授权」）。默认下 480P。
// 会把仓库根目录 sessdata.txt 里的登录 cookie 写进临时 profile（测完连同 profile 和下载的文件一起删掉，--keep 时保留下载的文件）。
// --mem：每 10 秒记一次这个 Chrome 所有进程的内存（Windows 的工作集），确认没有把整个文件放进内存。
// 用法: node tests/dl_ext_test.mjs <e2e|resume|speed> [BV号] [分P] [qn] [codec] [--ref 参考.mp4] [--at 0.4] [--secs 30] [--out 目录] [--workers 16] [--mem] [--keep]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CDP, evaluate } from "./cdp.mjs";
import { buildDl } from "../tools/build_ext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const [MODE = "e2e", BVID = "BV1Q24y1j7YT", PAGE = "1", QN = "120", CODEC = "avc"] = pos;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = () => new Date().toTimeString().slice(0, 8);

class Browser {
  constructor() {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), "bilidl-dl-"));
    this.dl = opt("out") ? fs.mkdtempSync(path.join(opt("out"), "bilidl-dl-out-")) : path.join(this.profile, "downloads");
    fs.mkdirSync(this.dl, { recursive: true });
    // 下载目录写进 profile 的设置（不用 CDP 的 setDownloadBehavior：它会改掉 chrome.downloads 给的文件名）
    fs.mkdirSync(path.join(this.profile, "Default"), { recursive: true });
    fs.writeFileSync(path.join(this.profile, "Default", "Preferences"), JSON.stringify({
      download: { default_directory: this.dl, prompt_for_download: false, directory_upgrade: true },
    }));
  }

  async start(first = true) {
    this.child = spawn(CHROME, [...(this.headed ? [] : ["--headless=new"]), "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
      `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "about:blank"],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    this.exited = new Promise(r => this.child.on("exit", r));
    process.on("exit", () => this.child.kill());
    this.cdp = new CDP(this.child);
    const ver = await this.cdp.send("Browser.getVersion");
    this.extId = (await this.cdp.send("Extensions.loadUnpacked", { path: buildDl() })).id;
    if (first) console.log(ver.product, "插件", this.extId, "下载目录", this.dl);
    // 每次启动都写：resume 测试强杀进程时，刚写进去的 cookie 还没存盘，重启后就没了
    const sess = fs.existsSync(path.join(ROOT, "sessdata.txt")) && fs.readFileSync(path.join(ROOT, "sessdata.txt"), "utf8").trim();
    if (sess) await this.cdp.send("Storage.setCookies", { cookies: [{ name: "SESSDATA", value: sess, domain: ".bilibili.com",
      path: "/", secure: true, httpOnly: true, expires: Date.now() / 1000 + 86400 }] });
    else if (first) console.log("没有 sessdata.txt，以游客身份测试（最高 480P）");
    // 插件页面（弹出页在标签页里打开），用来发操作、收任务状态
    const url = `chrome-extension://${this.extId}/popup.html?url=${encodeURIComponent(`https://www.bilibili.com/video/${BVID}/?p=${PAGE}`)}`;
    const { targetId } = await this.cdp.send("Target.createTarget", { url });
    this.sid = (await this.cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await sleep(1500);
    await this.ev(`(window.__st = null, chrome.runtime.onMessage.addListener(m => { if (m.type === "dl-state") window.__st = m.tasks; }), 1)`);
  }

  ev(expr) { return evaluate(this.cdp, this.sid, expr); }
  op(m) { return this.ev(`chrome.runtime.sendMessage(${JSON.stringify({ target: "bg", ...m })})`); }
  async state() { await this.op({ op: "list" }); await sleep(200); return this.ev("window.__st"); }

  /** 正常关闭（cookie、权限等都会存盘），和用户关掉浏览器一样 */
  async close() {
    await this.cdp.send("Browser.close").catch(() => {});
    await this.exited;
    await sleep(1000);
  }

  async kill() {
    this.child.kill("SIGKILL");
    await this.exited;
    await sleep(500);
  }

  async stop() {
    this.child.kill();
    await this.exited;
    await sleep(800);
    fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    if (opt("out") && !argv.includes("--keep")) fs.rmSync(this.dl, { recursive: true, force: true });
  }
}

async function addTask(b) {
  if (opt("workers")) await b.ev(`(async () => { const { kvSet } = await import("./src/db.js"); await kvSet("settings", { workers: ${+opt("workers")}, format: "mp4" }); })()`);
  const items = await b.ev(`(async () => {
    const api = await import("./src/api.js");
    const meta = await api.videoMeta(${JSON.stringify(BVID)});
    const p = meta.pages.find(x => x.page === ${+PAGE});
    return [{ bvid: ${JSON.stringify(BVID)}, cid: p.cid, page: p.page, part: p.part, title: meta.title, nPages: meta.pages.length, duration: p.duration, qn: ${+QN}, codec: ${JSON.stringify(CODEC)} }];
  })()`);
  await b.op({ op: "add", items });
  console.log(t(), "已添加任务", items[0].title, `P${PAGE}`, `qn ${QN} ${CODEC}`);
}

/** 每秒看一次任务状态，直到 until(任务) 为真；打印进度。返回 { task, marks: [[秒, 字节]] }。 */
async function watch(b, until, limit = 3600) {
  const t0 = Date.now(), marks = [];
  let last = 0, task = null;
  while ((Date.now() - t0) / 1000 < limit) {
    const st = await b.state();
    task = st?.[st.length - 1];
    if (task) {
      marks.push([(Date.now() - t0) / 1000, task.done]);
      if (Date.now() - last > 5000) {
        last = Date.now();
        console.log(t(), task.status, task.total ? `${(task.done / task.total * 100).toFixed(1)}%` : "", `${(task.done / 1e6).toFixed(0)}/${(task.total / 1e6).toFixed(0)} MB`,
          `${(task.speed / 1048576).toFixed(1)} MB/s`, task.qname || "", task.err || "");
      }
      if (task.status === "error") throw new Error("任务出错：" + task.err);
      if (until(task)) return { task, marks };
    }
    await sleep(800);
  }
  throw new Error("等太久了");
}

/** 这个 Chrome（按 profile 目录认）所有进程的工作集之和，MB。只支持 Windows。 */
function chromeMem(profile) {
  const ps = `$p = Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' }; [math]::Round(($p | Measure-Object WorkingSetSize -Sum).Sum / 1MB)`;
  try { return +execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim(); } catch { return NaN; }
}

function rates(marks) {
  const first = marks.find(m => m[1] > 0);
  if (!first) return {};
  const last = marks[marks.length - 1];
  const steady = marks.find(m => m[0] >= first[0] + 3);
  return { avg: (last[1] - first[1]) / (last[0] - first[0]) / 1048576,
           steady: steady && last[0] > steady[0] ? (last[1] - steady[1]) / (last[0] - steady[0]) / 1048576 : null };
}

const hash = f => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"], { encoding: "utf8", maxBuffer: 1 << 26 }).trim();

function outFile(b) {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
  walk(b.dl);
  return files.filter(f => f.endsWith(".mp4"));
}

let bad = 0;
const check = (ok, label) => { if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${label}`); };

function verify(b) {
  const files = outFile(b);
  check(files.length === 1, `下载目录里有 1 个 mp4：${files.map(f => path.relative(b.dl, f)).join(", ")}`);
  if (!files.length) return;
  const f = files[0];
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,duration,nb_frames:format=duration,size", "-of", "json", f], { encoding: "utf8" }));
  console.log("ffprobe", JSON.stringify(probe));
  if (opt("ref")) {
    const t0 = Date.now();
    check(hash(f) === hash(opt("ref")), `每个流的 packet 数据哈希和参考文件一致（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  }
}

async function e2e() {
  const b = new Browser();
  await b.start();
  try {
    await addTask(b);
    const t0 = Date.now();
    const mem = [];
    const iv = argv.includes("--mem") ? setInterval(() => mem.push(chromeMem(b.profile)), 10000) : null;
    const phases = {};
    const { task, marks } = await watch(b, x => { if (!phases[x.status]) phases[x.status] = (Date.now() - t0) / 1000; return x.status === "done"; });
    clearInterval(iv);
    if (mem.length) console.log(`Chrome 内存（MB，每 10 秒）：${mem.join(" ")}，最高 ${Math.max(...mem)}`);
    console.log("各阶段开始的时间（秒）", JSON.stringify(phases));
    const r = rates(marks);
    console.log(t(), `完成，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒，平均 ${r.avg?.toFixed(1)} MB/s，保存到 ${task.savedTo}`);
    verify(b);
    const dbg = await b.ev(`new Promise(ok => { chrome.runtime.onMessage.addListener(function h(m) { if (m.type === "dl-debug") { chrome.runtime.onMessage.removeListener(h); ok(m); } });
      chrome.runtime.sendMessage({ target: "bg", op: "debug" }); })`);
    check(dbg.files.length === 0, `保存后 OPFS 里的临时文件已删除（${JSON.stringify(dbg.files)}）`);
  } finally {
    await b.stop();
  }
}

async function resume() {
  const b = new Browser();
  await b.start();
  try {
    await addTask(b);
    const at = +opt("at", 0.4);
    const { task: before } = await watch(b, x => x.status === "running" && x.total && x.done >= x.total * at);
    console.log(t(), `下到 ${(before.done / before.total * 100).toFixed(1)}%，杀掉 Chrome 进程`);
    await b.kill();
    await b.start(false);
    const st = await (async () => { for (let i = 0; i < 20; i++) { const s = await b.state(); if (s?.length) return s; await sleep(500); } return null; })();
    const after = st?.[st.length - 1];
    console.log(t(), "重启后", after?.status, `${(after?.done / 1e6).toFixed(0)} MB`);
    check(after && after.done > 0 && after.done <= before.done, `重启后保留了进度（杀掉前 ${(before.done / 1e6).toFixed(0)} MB，重启后从 ${(after?.done / 1e6).toFixed(0)} MB 开始）`);
    await watch(b, x => x.status === "done");
    verify(b);
  } finally {
    await b.stop();
  }
}

async function speed() {
  const b = new Browser();
  await b.start();
  try {
    await addTask(b);
    const secs = +opt("secs", 30);
    let firstAt = null;
    const { marks } = await watch(b, x => {
      if (x.done > 0 && firstAt === null) firstAt = Date.now();
      return firstAt !== null && Date.now() - firstAt > secs * 1000;
    });
    const r = rates(marks);
    console.log(`插件 ${BVID} P${PAGE} qn ${QN} ${CODEC}，${secs} 秒：平均（首字节起）${r.avg.toFixed(2)} MB/s，稳态（3 秒后）${r.steady?.toFixed(2)} MB/s`);
    const st = await b.state();
    await b.op({ op: "remove", id: st[st.length - 1].id });
    await sleep(1000);
  } finally {
    await b.stop();
  }
}

/** 等插件发来某种消息（发一个操作后） */
const ask = (b, op, type) => b.ev(`new Promise(ok => { chrome.runtime.onMessage.addListener(function h(m) { if (m.type === ${JSON.stringify(type)}) { chrome.runtime.onMessage.removeListener(h); ok(m); } });
  chrome.runtime.sendMessage({ target: "bg", op: ${JSON.stringify(op)} }); })`);
const pagePerm = b => b.ev(`(async () => { const { kvGet } = await import("./src/db.js"); const d = await kvGet("dir"); return d ? { name: d.name, state: await d.queryPermission({ mode: "readwrite" }) } : null; })()`);

async function openSettings(b) {
  const { targetId } = await b.cdp.send("Target.createTarget", { url: `chrome-extension://${b.extId}/popup.html?page=settings` });
  await b.cdp.send("Target.activateTarget", { targetId });
}

async function fsa() {
  const b = new Browser();
  b.headed = true;
  await b.start();
  try {
    await openSettings(b);
    console.log(t(), "【请操作】在打开的 Chrome 里，「bilidl 下载」设置页上点「选择保存目录」，选一个空文件夹并允许编辑。");
    let p;
    while (!(p = await pagePerm(b))) await sleep(1000);
    console.log(t(), "页面里：", JSON.stringify(p), " Worker 里：", JSON.stringify(await ask(b, "perm", "dl-perm")));
    await addTask(b);
    const { task } = await watch(b, x => x.status === "done");
    console.log(t(), "保存到：", task.savedTo);
    check(task.savedTo.startsWith(p.name + "/"), "下载的文件写进了选的目录（不是下载目录）");
    console.log(t(), "正常关闭 Chrome，再用同一个 profile 启动");
    await b.close();
    await b.start(false);
    const p2 = await pagePerm(b), w2 = await ask(b, "perm", "dl-perm");
    console.log(t(), "重启后 页面里：", JSON.stringify(p2), " Worker 里：", JSON.stringify(w2));
    if (p2?.state !== "granted") {
      await openSettings(b);
      console.log(t(), "【请操作】授权没有保留。请在设置页点「重新授权」，留意 Chrome 弹出的提示里有没有「始终允许」之类的选项，选它（没有就选允许）。");
      let p3;
      while ((p3 = await pagePerm(b))?.state !== "granted") await sleep(1000);
      console.log(t(), "重新授权后 Worker 里：", JSON.stringify(await ask(b, "perm", "dl-perm")));
      console.log(t(), "再正常关闭、启动一次，看「始终允许」能不能留住");
      await b.close();
      await b.start(false);
      console.log(t(), "第二次重启后 页面里：", JSON.stringify(await pagePerm(b)), " Worker 里：", JSON.stringify(await ask(b, "perm", "dl-perm")));
    }
  } finally {
    await b.stop();
  }
}

const MODES = { e2e, resume, speed, fsa };
if (!MODES[MODE]) { console.log("模式只能是", Object.keys(MODES).join(" / ")); process.exit(2); }
MODES[MODE]().then(() => { if (MODE !== "speed") console.log(bad ? `\n${bad} 项失败` : "\n全部通过"); process.exit(bad ? 1 : 0); },
  e => { console.error(e); process.exit(1); });
