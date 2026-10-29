// 弹出页：当前标签页的视频（选分P、清晰度、编码，开始下载）和下载任务列表。
// ?page=settings 时是设置页（在普通标签页里打开：选保存目录要弹出文件夹选择框，弹出页一失去焦点就会关掉）。
// ?url=<视频链接> 可以直接指定视频（测试用）。
import * as api from "./src/api.js";
import { kvGet, kvSet, getSettings } from "./src/db.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SETTINGS = params.get("page") === "settings";
const send = m => chrome.runtime.sendMessage({ target: "bg", ...m });
const gb = n => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(0) + " MB";
const STATUS = { queued: "排队中", running: "下载中", paused: "已暂停", finishing: "收尾中", saving: "正在保存", done: "已完成", error: "出错" };

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}

// ---------- 当前视频 ----------
async function currentUrl() {
  if (params.get("url")) return params.get("url");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

async function showVideo() {
  const box = $("video");
  const target = api.parseTarget(await currentUrl());
  const navp = api.nav().then(n => {
    $("login").textContent = n.login ? (n.vip ? "已登录（大会员）" : "已登录") : "未登录";
    $("login").className = n.login ? "muted" : "warn";
    return n;
  }).catch(() => null);
  if (!target) {
    box.replaceChildren(el("div", { class: "muted" }, "打开 B 站的视频页，再点插件图标就能下载。"));
    return;
  }
  const meta = await api.videoMeta(target.bvid);
  const pages = meta.pages;
  const cur = pages.find(p => p.page === target.page) || pages[0];
  const pageSel = el("select", { id: "page" },
    ...pages.map(p => el("option", { value: p.page, selected: p === cur }, pages.length > 1 ? `P${p.page} ${p.part}` : p.part || meta.title)),
    pages.length > 1 ? el("option", { value: "all" }, `全部 ${pages.length} 个分P`) : null);
  const qSel = el("select", { id: "quality" }), cSel = el("select", { id: "codec" });
  const go = el("button", { class: "primary", id: "go" }, "下载");
  const hint = el("div", { class: "hint" });
  box.replaceChildren(el("div", { class: "title", title: meta.title }, meta.title), pageSel, el("div", { class: "row" }, qSel, cSel, go), hint);
  if (pages.length <= 1) pageSel.hidden = true;

  let quals = [];
  const loadQualities = async () => {
    const p = pageSel.value === "all" ? pages[0] : pages.find(x => x.page === +pageSel.value);
    go.disabled = true;
    try {
      const d = await api.playurl(target.bvid, p.cid);
      if (!d.dash) throw new Error("这个视频没有 DASH 流（可能需要付费或有地区限制）");
      quals = api.qualities(d.dash);
    } catch (e) {
      hint.textContent = "读取清晰度失败：" + e.message;
      hint.className = "hint warn";
      return;
    }
    const keep = +qSel.value;
    const allP = pageSel.value === "all" ? "（按 P1 估算）" : "";
    qSel.replaceChildren(...quals.map((q, i) => el("option", { value: q.qn, selected: keep ? q.qn === keep : i === 0 }, `${q.name} · ${gb(q.size)}${allP}`)));
    showCodecs();
    go.disabled = false;
    const n = await navp;
    hint.className = "hint";
    hint.textContent = n && !n.login ? "未登录时最高 480P：在这个浏览器里登录 B 站后再打开即可。" : "";
  };
  const showCodecs = () => {
    const q = quals.find(x => x.qn === +qSel.value);
    const keep = cSel.value || "avc";
    const names = { avc: "H.264", hevc: "H.265", av1: "AV1" };
    cSel.replaceChildren(...(q?.codecs || []).map(c => el("option", { value: c, selected: c === keep }, names[c] || c)));
    cSel.title = "H.264 兼容性最好；H.265、AV1 体积小，但老设备可能放不了";
    qSel.title = q ? `${q.name} ${q.res}，约 ${gb(q.size)}` : "";
  };
  pageSel.addEventListener("change", loadQualities);
  qSel.addEventListener("change", showCodecs);
  go.addEventListener("click", async () => {
    const sel = pageSel.value === "all" ? pages : [pages.find(x => x.page === +pageSel.value)];
    const items = sel.map(p => ({ bvid: target.bvid, cid: p.cid, page: p.page, part: p.part, title: meta.title, nPages: pages.length,
                                  duration: p.duration, qn: +qSel.value, codec: cSel.value || "avc" }));
    go.disabled = true;
    await send({ op: "add", items });
    go.textContent = "已加入";
    setTimeout(() => { go.textContent = "下载"; go.disabled = false; }, 1500);
  });
  await loadQualities();
}

// ---------- 任务列表 ----------
function renderTasks(tasks) {
  $("empty").hidden = tasks.length > 0;
  $("tasks").replaceChildren(...tasks.slice().reverse().map(t => {
    const pct = t.total ? t.done / t.total * 100 : 0;
    const act = (label, op) => el("button", { class: "link", onclick: () => send({ op, id: t.id }) }, label);
    const acts = [];
    if (["queued", "running"].includes(t.status)) acts.push(act("暂停", "pause"));
    if (["paused", "error"].includes(t.status)) acts.push(act("继续", "resume"));
    if (t.status !== "finishing" && t.status !== "saving") acts.push(act(t.status === "done" ? "移除" : "删除", "remove"));
    let info = STATUS[t.status] || t.status;
    if (t.status === "running" || t.status === "paused") info += ` ${pct.toFixed(1)}%  ${gb(t.done)} / ${gb(t.total)}` + (t.status === "running" && t.speed ? `  ${(t.speed / 1048576).toFixed(1)} MB/s` : "");
    if (t.status === "done") info = "已保存：" + t.savedTo.split(/[\\/]/).slice(-2).join("/");
    return el("li", {},
      el("div", { class: "name", title: t.name }, t.name.split("/").pop()),
      t.status === "done" ? null : el("div", { class: "bar" }, el("div", { style: `width:${pct}%` })),
      el("div", { class: "meta" }, el("span", {}, `${t.qname || ""} ${info}`), el("span", { class: "acts" }, ...acts)),
      t.err ? el("div", { class: "err" }, t.err) : null);
  }));
}

chrome.runtime.onMessage.addListener(m => { if (m?.type === "dl-state") renderTasks(m.tasks); });

// ---------- 保存位置 / 设置 ----------
async function showWhere() {
  const dir = await kvGet("dir");
  let text = "保存到：浏览器的下载目录";
  if (dir) {
    const perm = await dir.queryPermission({ mode: "readwrite" });
    text = `保存到：${dir.name}` + (perm === "granted" ? "" : "（需要重新授权，先存到下载目录）");
  }
  $("where").textContent = text;
  $("where").title = text;
}

async function showSettings() {
  document.body.classList.add("tab");
  $("video").hidden = true;
  const box = $("settings");
  box.hidden = false;
  const s = await getSettings();
  const dir = await kvGet("dir");
  const perm = dir ? await dir.queryPermission({ mode: "readwrite" }) : "";
  const status = el("div", { class: "hint" });
  const pick = el("button", { class: "primary", onclick: async () => {
    try {
      const h = await window.showDirectoryPicker({ id: "bilidl-dl", mode: "readwrite" });
      await kvSet("dir", h);
      status.textContent = `已选择：${h.name}，权限 ${await h.queryPermission({ mode: "readwrite" })}`;
      refresh();
    } catch (e) { status.textContent = "没有选择：" + e.message; }
  } }, dir ? "换一个目录" : "选择保存目录");
  const regrant = dir && perm !== "granted" ? el("button", { onclick: async () => {
    status.textContent = "权限：" + await dir.requestPermission({ mode: "readwrite" });
    refresh();
  } }, "重新授权") : null;
  const reset = dir ? el("button", { onclick: async () => { await kvSet("dir", undefined); refresh(); } }, "改回下载目录") : null;
  const workers = el("select", { onchange: async e => { await kvSet("settings", { ...s, workers: +e.target.value }); status.textContent = "并发数已保存，下一个任务开始生效"; } },
    ...[4, 8, 16, 24, 32].map(n => el("option", { value: n, selected: n === s.workers }, `并发 ${n}`)));
  box.replaceChildren(
    el("div", { class: "title" }, "保存位置"),
    el("div", {}, dir ? `${dir.name}（权限：${perm === "granted" ? "可以写入" : perm}）` : "浏览器的下载目录（chrome://settings/downloads 里设置的位置）"),
    el("div", { class: "row" }, pick, regrant, reset),
    el("div", { class: "hint" }, "下载时先写在插件自己的存储里（可以断点续传），下完再复制到这里。选了目录但没有权限时，会先存到下载目录。"),
    el("div", { class: "title", style: "margin-top:14px" }, "同时下载的分段数"),
    el("div", { class: "row" }, workers),
    status);
}

function refresh() {
  if (SETTINGS) showSettings();
  showWhere();
}

$("change").addEventListener("click", () => {
  if (SETTINGS) return;
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?page=settings") });
  window.close();
});
$("clear").addEventListener("click", () => send({ op: "clearDone" }));
refresh();
if (!SETTINGS) showVideo().catch(e => { $("video").replaceChildren(el("div", { class: "warn" }, "读取视频信息失败：" + e.message)); });
send({ op: "list" });
