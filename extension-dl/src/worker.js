// 下载插件的后台：offscreen document 里的专用 Worker。管任务队列、输出文件（OPFS）和断点续传的进度（IndexedDB）。
// 为什么先写进 OPFS：用户目录只能用 createWritable 写，它写的是临时的 .crswap，close() 之前浏览器被关掉的话写过的全部丢掉，
// 续传时 keepExistingData 还要先把整个文件复制一遍（1 GB 约 6 秒）。OPFS 的 SyncAccessHandle 是原地写，flush 之后不会丢。
// 下完再一次性复制到用户选的目录，或者交给 chrome.downloads 存到下载目录。见 docs/DOWNLOAD_EXTENSION.md。
import * as api from "./api.js";
import { parseHead, layout, finish } from "./mux.js";
import { Download, chunkCounts } from "./download.js";
import { HostHealth, candidates, pick } from "../../shared/hosts.js";
import { getAll, putTask, delTask, kvGet, getSettings } from "./db.js";

const SAVE_EVERY = 2000;  // 毫秒：flush 文件并保存进度的间隔
const ACTIVE = ["queued", "running", "finishing"];
const tasks = new Map();  // id -> 任务（存进 IndexedDB 的字段）
const live = new Map();   // id -> { ctl, dl }：正在运行的任务
let running = null;       // 正在运行的任务 id（一次只下一个）
const post = m => postMessage(m);
const log = (...a) => console.log("[bilidl-dl]", ...a);

const ready = (async () => {
  for (const t of await getAll()) {
    if (t.status === "running" || t.status === "finishing") t.status = "queued";  // 上次没跑完（关了浏览器等），接着下
    tasks.set(t.id, t);
  }
  for (const t of tasks.values()) if (t.status === "saving") exportFile(t).catch(e => fail(t, e));
  schedule();
})();

function summary(t) {
  const p = live.get(t.id)?.dl?.progress();
  return { id: t.id, title: t.title, part: t.part, page: t.page, nPages: t.nPages, name: t.name, qname: t.qname, res: t.res,
           codec: t.codec, status: t.status, err: t.err || "", done: p ? p.done : t.doneBytes || 0, total: t.total || 0,
           speed: p ? p.speed : 0, savedTo: t.savedTo || "", created: t.created };
}

let lastState = 0;
function broadcast(force = true) {
  if (!force && Date.now() - lastState < 900) return;
  lastState = Date.now();
  post({ type: "dl-state", tasks: [...tasks.values()].sort((a, b) => a.created - b.created).map(summary) });
}

async function save(t) {
  tasks.set(t.id, t);
  await putTask(t);
  broadcast();
}

function fail(t, e) {
  log("任务失败", t.name, e);
  t.status = "error";
  t.err = e?.message || String(e);
  return save(t);
}

function schedule() {
  if (running) return;
  const next = [...tasks.values()].filter(t => t.status === "queued").sort((a, b) => a.created - b.created)[0];
  if (!next) { post({ type: "idle", busy: [...tasks.values()].some(t => t.status === "saving") }); return; }
  running = next.id;
  run(next).finally(() => { running = null; schedule(); });
}

/** 取 m4s 开头的 init + sidx（0 到 index_range 的结尾），几个节点轮流试。 */
async function fetchHead(links, indexRange, signal) {
  const end = +String(indexRange).split("-")[1];
  if (!end) throw new Error("playurl 里没有 segment_base，不知道 sidx 在哪里");
  const health = new HostHealth();
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { url } = pick(health, candidates(links.tmpl, links.urls), true, attempt);
    try {
      const r = await fetch(url, { headers: { Range: `bytes=0-${end}` }, signal, credentials: "omit", cache: "no-store" });
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== end + 1) throw new Error(`short read ${b.length}/${end + 1}`);
      return b;
    } catch (e) {
      signal.throwIfAborted();
      health.fail(url, e.message);
      last = e;
    }
  }
  throw new Error("取不到文件头：" + (last?.message || last));
}

const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

async function findStreams(t) {
  const data = await api.playurl(t.bvid, t.cid, t.qn);
  const dash = data.dash;
  if (!dash) throw new Error("这个视频没有 DASH 流（可能需要付费或有地区限制）");
  if (t.vid) {  // 续传或刷新链接：必须是同一个流
    const v = dash.video.find(x => x.id === t.vid && x.codecs === t.vcodecs);
    const a = t.aid ? api.allAudio(dash).find(x => x.id === t.aid) : null;
    if (!v || (t.aid && !a)) throw new Error(`现在拿不到 ${t.qname} ${t.vcodecs} 了（登录状态变了？）`);
    return [v, a];
  }
  const [v, a] = api.pickStreams(dash, t.qn, t.codec);
  Object.assign(t, { vid: v.id, vcodecs: v.codecs, aid: a?.id ?? null, qname: api.QN_NAME[v.id] || String(v.id), res: `${v.width}x${v.height}` });
  return [v, a];
}

async function run(t) {
  const ctl = new AbortController();
  const me = { ctl, dl: null };
  live.set(t.id, me);
  let h = null, timer = null;
  t.status = "running";
  t.err = "";
  await save(t);
  try {
    const settings = await getSettings();
    const streams = (await findStreams(t)).filter(Boolean);
    const links = streams.map(api.streamUrls);
    const heads = await Promise.all(streams.map((s, i) => fetchHead(links[i], (s.segment_base || s.SegmentBase || {}).index_range ?? s.SegmentBase?.indexRange, ctl.signal)));
    const tracks = heads.map(b => parseHead(b));
    tracks[0].fps = parseFloat(streams[0].frameRate || streams[0].frame_rate) || 0;
    const lay = layout(tracks, { format: t.format || settings.format });
    t.format = lay.format;
    const counts = chunkCounts(lay);
    // B 站换了文件（重新转码）或者第一次下：从头开始
    const fresh = !t.done || !t.heads || t.heads.length !== heads.length || !heads.every((b, i) => sameBytes(b, t.heads[i]))
      || t.done.length !== counts.length || t.done.some((b, i) => b.length !== counts[i]);
    if (fresh) t.done = counts.map(n => new Uint8Array(n));
    t.heads = heads;
    t.total = tracks.reduce((s, x) => s + x.dataEnd - x.dataStart, 0);
    const est = await navigator.storage.estimate();
    const have = fresh ? 0 : t.doneBytes || 0;
    if (est.quota - est.usage < lay.size - have + (64 << 20)) throw new Error(`浏览器给插件的空间不够：还要 ${((lay.size - have) / 1e9).toFixed(1)} GB，只剩 ${((est.quota - est.usage) / 1e9).toFixed(1)} GB`);
    const root = await navigator.storage.getDirectory();
    h = await (await root.getFileHandle(t.opfs, { create: true })).createSyncAccessHandle();
    if (fresh || h.getSize() !== lay.size) {
      if (!fresh) t.done = counts.map(n => new Uint8Array(n));  // 文件大小不对，进度不可信
      h.truncate(0);
      h.truncate(lay.size);
      h.write(lay.header, { at: 0 });
      h.flush();
    }
    await save(t);
    log(`${t.name}：${t.qname} ${t.vcodecs}，${(lay.size / 1e6).toFixed(0)} MB，已完成 ${t.done.reduce((s, b) => s + b.reduce((x, y) => x + y, 0), 0)}/${counts.reduce((a, b) => a + b)} 段`);

    // 进度：位图就地更新，但只有 flush 之后的才存进 IndexedDB（先写数据、flush，再记进度）
    const persist = async () => {
      const snap = t.done.map(b => b.slice());
      h.flush();
      t.doneBytes = me.dl.progress().done;
      await putTask({ ...t, done: snap });
    };
    me.dl = new Download({
      lay, streams: links, done: t.done, workers: settings.workers, log,
      refresh: async i => api.streamUrls((await findStreams(t))[i]),
      write: (pos, data) => { h.write(data, { at: pos }); },
    });
    let saving = Promise.resolve();
    timer = setInterval(() => { saving = saving.then(persist).catch(e => log("保存进度失败", e)); broadcast(false); }, SAVE_EVERY);
    await me.dl.run(ctl.signal);
    clearInterval(timer);
    timer = null;
    await saving;

    t.status = "finishing";
    await save(t);
    const fin = await finish(lay, (pos, len) => { const b = new Uint8Array(len); h.read(b, { at: pos }); return b; });
    for (const [pos, data] of fin.writes) h.write(data, { at: pos });
    h.truncate(fin.size);
    h.flush();
    h.close();
    h = null;
    t.doneBytes = t.total;
    t.done = null;  // 下完了，位图不再需要（文件头留着，万一保存失败要重新收尾时用不上，但很小）
    t.status = "saving";
    await save(t);
    live.delete(t.id);
    await exportFile(t);
  } catch (e) {
    if (ctl.signal.aborted) {
      const why = ctl.signal.reason?.message;
      if (why !== "remove") { t.status = "paused"; await save(t); }
    } else await fail(t, e);
  } finally {
    if (timer) clearInterval(timer);
    if (h) {
      try {
        if (t.done && me.dl) { h.flush(); t.doneBytes = me.dl.progress().done; await putTask({ ...t }); }
        h.close();
      } catch (e) { log("关闭文件失败", e); }
    }
    live.delete(t.id);
    broadcast();
  }
}

/** 下完的文件从 OPFS 复制出去：用户选过目录并且还有权限就写到那里，否则交给 offscreen → 后台用 chrome.downloads 存到下载目录。 */
async function exportFile(t) {
  const root = await navigator.storage.getDirectory();
  const dir = await kvGet("dir");
  let perm = "none";
  try { if (dir) perm = await dir.queryPermission({ mode: "readwrite" }); } catch (e) { perm = "error: " + e.message; }
  if (dir && perm === "granted") {
    const parts = (t.name + ".mp4").split("/");
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const file = await unique(d, parts[parts.length - 1]);
    const src = await (await root.getFileHandle(t.opfs)).getFile();
    const t0 = performance.now();
    const w = await (await d.getFileHandle(file, { create: true })).createWritable();
    await src.stream().pipeTo(w);
    log(`复制到 ${dir.name}/${parts.slice(0, -1).concat(file).join("/")}：${(src.size / 1e6).toFixed(0)} MB，${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
    await root.removeEntry(t.opfs);
    t.status = "done";
    t.savedTo = [dir.name, ...parts.slice(0, -1), file].join("/");
    t.heads = null;
    await save(t);
    return;
  }
  if (dir) log("保存目录没有写权限（" + perm + "），改存到下载目录");
  post({ type: "export", id: t.id, opfs: t.opfs, filename: t.name + ".mp4" });
}

/** 目录里已经有同名文件时加上 (1)、(2)…，不覆盖。 */
async function unique(dir, name) {
  const dot = name.lastIndexOf(".");
  for (let i = 0; ; i++) {
    const n = i ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : name;
    try { await dir.getFileHandle(n); } catch { return n; }
  }
}

async function stop(id, why) {
  const l = live.get(id);
  if (!l) return;
  l.ctl.abort(new Error(why));
  while (live.has(id)) await new Promise(r => setTimeout(r, 50));
}

const ops = {
  async list() { broadcast(); },
  /** items: [{ bvid, cid, page, part, title, nPages, qn, codec }] */
  async add({ items }) {
    for (const it of items) {
      const dup = [...tasks.values()].find(t => t.bvid === it.bvid && t.cid === it.cid && t.qn === it.qn && t.codec === it.codec && t.status !== "done");
      if (dup) { if (dup.status === "paused" || dup.status === "error") { dup.status = "queued"; await save(dup); } continue; }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await save({ ...it, id, opfs: id + ".mp4", name: api.outName(it.title, it.nPages, it.page, it.part), status: "queued", created: Date.now() + tasks.size / 1000 });
    }
    schedule();
  },
  async pause({ id }) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.status === "queued") { t.status = "paused"; await save(t); }
    else await stop(id, "pause");
  },
  async resume({ id }) {
    const t = tasks.get(id);
    if (!t || !["paused", "error"].includes(t.status)) return;
    if (t.done === null && t.total && t.doneBytes === t.total) {
      t.status = "saving";  // 下完了只是保存失败：重新保存
      await save(t);
      await exportFile(t).catch(e => fail(t, e));
      return;
    }
    t.status = "queued";
    await save(t);
    schedule();
  },
  async remove({ id }) {
    const t = tasks.get(id);
    if (!t) return;
    await stop(id, "remove");
    try { await (await navigator.storage.getDirectory()).removeEntry(t.opfs); } catch { /* 没有文件 */ }
    tasks.delete(id);
    await delTask(id);
    broadcast();
  },
  /** 后台用 chrome.downloads 存完（或失败）后通知 */
  async exported({ id, ok, error, path }) {
    const t = tasks.get(id);
    if (!t) return;
    if (!ok) return fail(t, new Error(`保存到下载目录失败：${error}（文件还在插件里，可以点「继续」重新保存）`));
    try { await (await navigator.storage.getDirectory()).removeEntry(t.opfs); } catch { /* 已经删了 */ }
    t.status = "done";
    t.savedTo = path || t.name + ".mp4";
    t.heads = null;
    await save(t);
  },
  async clearDone() {
    for (const t of [...tasks.values()]) if (t.status === "done") { tasks.delete(t.id); await delTask(t.id); }
    broadcast();
  },
  /** 测试用：Worker 里看到的保存目录权限（和页面里看到的可能不一样） */
  async perm() {
    const dir = await kvGet("dir");
    let state = null;
    try { state = dir ? await dir.queryPermission({ mode: "readwrite" }) : null; } catch (e) { state = "error: " + e.message; }
    post({ type: "dl-perm", name: dir?.name || null, state });
  },
  /** 测试用：查看 OPFS 里的文件和用量 */
  async debug() {
    const files = [];
    for await (const [n, fh] of (await navigator.storage.getDirectory()).entries()) files.push([n, fh.kind === "file" ? (await fh.getFile()).size : -1]);
    post({ type: "dl-debug", files, estimate: await navigator.storage.estimate() });
  },
};

onmessage = async e => {
  await ready;
  const m = e.data;
  try { await ops[m.op]?.(m); }
  catch (err) { log("操作失败", m.op, err); post({ type: "dl-error", op: m.op, error: err.message || String(err) }); }
};
