// 弹出页：开关、档位，以及当前标签页的加速状态（每秒向 bridge.js 要一次）。
const PROFILES = /*PROFILES*/null;  // 打包时由 tools/build_ext.mjs 换成 engine.js 里的 PROFILES
const DEFAULTS = { playEnabled: true, playProfile: "mid" };
const $ = id => document.getElementById(id);
const mb = n => (n / (1 << 20)).toFixed(n >= 10 << 20 ? 0 : 1);
const short = h => (h || "").replace(/^upos-[a-z]+-/, "").replace(/\.(bilivideo\.com|akamaized\.net)$/, "");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function showConfig(c) {
  $("enabled").checked = c.playEnabled;
  for (const b of $("profiles").children) b.classList.toggle("on", b.dataset.p === c.playProfile);
  const p = PROFILES?.[c.playProfile];
  $("profileHint").textContent = p
    ? `并发 ${p.workers} + ${p.urgent}，预读约 ${p.aheadSec} 秒（最多 ${mb(p.aheadMax)} MB），每个标签页最多占 ${mb(p.mem)} MB 内存`
    : "";
}

chrome.storage.local.get(DEFAULTS, showConfig);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(DEFAULTS, showConfig));
$("enabled").addEventListener("change", e => chrome.storage.local.set({ playEnabled: e.target.checked }));
$("profiles").addEventListener("click", e => {
  if (e.target.dataset.p) chrome.storage.local.set({ playProfile: e.target.dataset.p });
});

function render(st) {
  const box = $("status");
  box.replaceChildren();
  if (!st) {
    box.append(el("div", "muted", "在 B 站的视频页、列表页、番剧页上会显示加速状态。"));
    box.append(el("div", "hint", "刚装好插件时，需要刷新一下已经打开的视频页。"));
    return;
  }
  if (!st.enabled) {
    box.append(el("div", "muted", "已关闭：播放器直连 B 站，和没装插件一样。"));
    return;
  }
  if (!st.counts.served && !st.counts.fallback) {
    box.append(el("div", "muted", st.counts.passed
      ? `播放器的 ${st.counts.passed} 个分段请求没有被接管（请求方式和预期的不同），现在是直连。`
      : "等待播放器请求视频…"));
    return;
  }
  const v = st.resources.find(r => r.kind === "video");
  const a = st.resources.find(r => r.kind === "audio");
  const buf = st.video?.buffered;
  const top = el("div", "row");
  const lead = el("div");
  lead.append(el("div", "muted", "领先播放位置"));
  lead.append(el("span", "big", `${Math.round((buf || 0) + (v?.aheadSec || 0))} 秒`));
  top.append(lead);
  const sp = el("div");
  sp.style.textAlign = "right";
  sp.append(el("div", "muted", "当前速度"));
  sp.append(el("span", "big", `${mb((v?.speed || 0) + (a?.speed || 0))} MB/s`));
  top.append(sp);
  box.append(top);
  box.append(el("div", "hint", `播放器缓冲 ${buf == null ? "–" : Math.round(buf)} 秒 + 插件预读 ${v?.aheadSec ?? "–"} 秒`
    + (st.video && st.video.rate !== 1 ? ` · ${st.video.rate} 倍速` : "")));

  const sec = el("div");
  sec.style.marginTop = "8px";
  for (const r of [v, a].filter(Boolean)) {
    const row = el("div", "row");
    row.append(el("span", "", `${r.kind === "video" ? "视频" : "音频"} · ${short(r.host) || "–"}`));
    row.append(el("span", "muted", `缓存 ${mb(r.cached)} MB · 窗口 ${mb(r.window)} MB`));
    sec.append(row);
  }
  box.append(sec);

  if (st.hosts.length) {
    const d = el("div");
    d.style.marginTop = "8px";
    d.append(el("div", "muted", "节点（单个请求的实测速度）"));
    const ul = el("ul");
    for (const h of st.hosts.slice(0, 6)) {
      const li = el("li");
      li.append(el("span", st.cooling.includes(h.host) ? "warn" : "", short(h.host) + (st.cooling.includes(h.host) ? "（暂停使用）" : "")));
      li.append(el("span", "muted", `${mb(h.speed)} MB/s`));
      ul.append(li);
    }
    d.append(ul);
    box.append(d);
  }

  const foot = el("div", "hint",
    `内存 ${mb(st.mem)} / ${mb(st.memMax)} MB · 接管 ${st.counts.served} 次` +
    (st.counts.fallback ? ` · 退回直连 ${st.counts.fallback} 次` : "") +
    (st.counts.passed ? ` · 未接管 ${st.counts.passed} 次` : ""));
  box.append(foot);
  if (st.logs.length) {
    const det = el("details");
    det.append(el("summary", "", "最近的记录"));
    det.append(el("pre", "", st.logs.join("\n")));
    box.append(det);
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let st = null;
  try { st = tab && await chrome.tabs.sendMessage(tab.id, { type: "stats" }); } catch {}
  // 展开着「最近的记录」时不刷新，免得每秒收起
  if (!document.querySelector("details[open]")) render(st);
}
refresh();
setInterval(refresh, 1000);
