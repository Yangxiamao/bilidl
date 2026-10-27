// 在 B 站视频页右下角加一个「下载」按钮。点开后列出清晰度和预计大小，选一个就把全部分P交给 bilidl-web 下载。
// 按钮和面板放在 Shadow DOM 里，不受 B 站样式影响；按钮固定在页面角落，不依赖 B 站工具栏的 DOM 结构。
"use strict";
(() => {
  if (document.getElementById("bilidl-ext-host")) return;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { --bg: #ffffff; --text: #1d2129; --muted: #6b7280; --line: #e3e5e8; --accent: #00a1d6; --accent-text: #fff;
  --soft: #e3f4fa; --err: #d93636; --ok: #1a9f53; --track: #e8eaed;
  position: fixed; right: 20px; bottom: 90px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 13px/1.5 "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; color: var(--text); }
@media (prefers-color-scheme: dark) {
  .wrap { --bg: #212226; --text: #e6e7ea; --muted: #9a9ea6; --line: #3a3c42; --accent: #23ade5; --accent-text: #0b1014;
    --soft: #15323e; --err: #f06262; --ok: #3ccf7c; --track: #34363c; }
}
button { font: inherit; color: inherit; cursor: pointer; }
.fab { border: 0; border-radius: 999px; padding: 8px 16px; background: var(--accent); color: var(--accent-text); font-weight: 600;
  box-shadow: 0 2px 10px rgba(0,0,0,.25); }
.fab:hover { filter: brightness(1.08); }
.panel { width: 340px; max-height: calc(100vh - 160px); overflow-y: auto; background: var(--bg); border: 1px solid var(--line);
  border-radius: 10px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
.top { display: flex; align-items: flex-start; gap: 8px; }
.title { flex: 1; font-weight: 600; font-size: 14px; word-break: break-all; }
.x { border: 0; background: none; color: var(--muted); font-size: 16px; line-height: 1; padding: 2px 4px; }
.muted { color: var(--muted); font-size: 12px; }
.err { color: var(--err); font-size: 12px; margin-top: 6px; word-break: break-all; }
.quals { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 8px; }
.q { display: flex; justify-content: space-between; gap: 8px; text-align: left; border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 10px; background: var(--bg); }
.q:hover:not(:disabled) { border-color: var(--accent); }
.q.def { border-color: var(--accent); background: var(--soft); }
.q:disabled { opacity: .45; cursor: default; }
.q b { font-weight: 600; }
.q .d { color: var(--muted); font-size: 12px; }
.q .s { white-space: nowrap; font-variant-numeric: tabular-nums; }
.links { display: flex; gap: 14px; margin-top: 8px; }
.link { border: 0; background: none; padding: 0; color: var(--accent); font-size: 12px; }
.bar { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin: 10px 0 4px; }
.bar > div { height: 100%; width: 0; background: var(--accent); transition: width .4s; }
.bar.done > div { background: var(--ok); }
.bar.bad > div { background: var(--err); }
.ok { color: var(--ok); }
.accel { display: flex; gap: 8px; align-items: baseline; margin-top: 6px; padding: 5px 8px; border-radius: 6px;
  background: var(--track); font-size: 12px; color: var(--muted); }
.accel.on { background: var(--soft); color: var(--text); }
.accel.warn { color: var(--err); }
.accel span { flex: 1; word-break: break-all; }
`;

  const host = document.createElement("div");
  host.id = "bilidl-ext-host";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="panel" hidden></div><button class="fab" title="用 bilidl 下载这个视频">⬇ 下载</button></div>`;
  document.documentElement.append(host);
  const panel = root.querySelector(".panel"), fab = root.querySelector(".fab");

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmtBytes(b) {
    if (!b) return "0 MB";
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
    return (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + " MB";
  }
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  async function send(type, extra) {
    let r;
    try { r = await chrome.runtime.sendMessage({ type, ...extra }); }
    catch (e) { throw new Error("插件已经更新或重新加载过，请刷新这个页面"); }
    if (!r || !r.ok) throw new Error((r && r.error) || "插件后台没有响应");
    return r.data;
  }

  let session = 0;      // 每次打开面板加一，关掉或重开后旧的请求结果和轮询作废
  let pollTimer = null;

  function close() {
    session++;
    clearTimeout(pollTimer);
    clearTimeout(accelTimer);
    panel.hidden = true;
  }

  // 面板顶部：标题 + 关闭按钮，下面是播放加速的状态行
  function frame(title) {
    panel.textContent = "";
    const top = el("div", "top");
    const x = el("button", "x", "✕"); x.title = "关闭"; x.onclick = close;
    top.append(el("div", "title", title), x);
    panel.append(top, accel);
  }

  // ---------- 播放加速状态（play.js 负责开关重定向，这里只显示） ----------
  const accel = el("div", "accel");
  let accelTimer = null;
  const WHY = {
    "off": "播放加速已关闭",
    "checking": "播放加速：正在连接 bilidl…",
    "lna-prompt": "播放加速：请在地址栏下方的提示里点「允许」（允许 B 站访问本机的 bilidl）",
    "lna-denied": "播放加速被 Chrome 拦截：点地址栏左侧的网站设置图标，把「本地网络访问」改为允许，再刷新页面",
    "not-running": "播放加速未生效：bilidl 没有运行，现在是直连播放",
    "proxy-failed": "播放加速暂停：bilidl 出错或已退出，已改回直连，稍后自动重试",
  };

  function renderAccel(s) {
    accel.textContent = "";
    if (!s) { accel.className = "accel"; accel.append(el("span", "", "播放加速：状态未知")); return; }
    const text = el("span");
    if (s.on) {
      const now = (s.stats && s.stats.resources || []).find(r => r.kind === "video" && r.idle < 30);
      const parts = ["⚡ 播放加速中"];
      if (now) {
        parts.push(now.ahead_sec != null ? `预读领先 ${Math.round(now.ahead_sec)} 秒` : `已预读 ${fmtBytes(now.ahead)}`);
        if (now.host) parts.push("节点 " + now.host.replace(/^upos-(sz-|hz-)?(mirror)?/, "").replace(/\..*$/, ""));
        parts.push(`${(now.speed / 1e6).toFixed(1)} MB/s`);
      }
      text.textContent = parts.join(" · ");
    } else {
      text.textContent = WHY[s.why] || WHY.checking;
      if (s.why === "proxy-failed" && s.detail)
        text.textContent += `（${Math.round((Date.now() - s.at) / 1000)} 秒前：${s.detail}）`;
    }
    accel.className = "accel" + (s.on ? " on" : ["lna-denied", "lna-prompt", "not-running"].includes(s.why) ? " warn" : "");
    const toggle = el("button", "link", s.pref ? "关闭" : "开启");
    toggle.title = s.pref ? "关闭后播放器直连 B 站，不经过 bilidl" : "让 bilidl 多线程预读视频，倍速也不卡";
    toggle.onclick = async () => { await chrome.storage.local.set({ playAccel: !s.pref }); setTimeout(refreshAccel, 500); };
    accel.append(text, toggle);
  }

  async function refreshAccel() {
    clearTimeout(accelTimer);
    if (panel.hidden) return;
    let s = null;
    try { s = await send("playStatus"); } catch (e) { /* 插件重新加载过 */ }
    if (panel.hidden) return;
    renderAccel(s);
    accelTimer = setTimeout(refreshAccel, 2000);
  }

  function showError(title, msg, url) {
    frame(title);
    panel.append(el("div", "err", msg));
    const links = el("div", "links");
    const retry = el("button", "link", "重试"); retry.onclick = open;
    links.append(retry);
    if (url) { const more = el("button", "link", "在 bilidl 里打开…"); more.onclick = () => send("openUI", { url }).catch(() => {}); links.append(more); }
    panel.append(links);
  }

  async function open() {
    const my = ++session;
    clearTimeout(pollTimer);
    const url = location.href;  // B 站切换分P/推荐视频是单页跳转，要在点击时读
    panel.hidden = false;
    frame("bilidl");
    refreshAccel();
    panel.append(el("div", "muted", "解析中…（会抽样几个分P测码率，需要几秒）"));
    let res;
    try { res = await send("prepare", { url }); }
    catch (e) { if (my === session) showError("bilidl", e.message, null); return; }
    if (my !== session) return;
    renderChoose(res, url);
  }

  function renderChoose({ sync, status, info }, url) {
    frame(info.title);
    const total = info.pages.reduce((a, p) => a + p.dur, 0);
    const n = info.pages.length;
    panel.append(el("div", "muted", [info.owner && "UP：" + info.owner,
      n > 1 ? `${n} 个分P，全部下载` : "单P", "总时长 " + fmtDur(total)].filter(Boolean).join(" · ")));

    const login = status.login ? (status.vip ? "大会员 · " : "已登录 · ") + status.uname
                : status.login === false ? "未登录（最高 480P）" : "登录状态未知";
    panel.append(el("div", "muted", login + (sync && sync.changed ? "（已从 Chrome 同步登录）" : "")));
    if (sync && sync.error) panel.append(el("div", "err", "同步登录失败：" + sync.error));

    const qs = info.qualities;
    if (!qs.length) { panel.append(el("div", "err", "没有可用清晰度")); return; }
    if (!status.ffmpeg) panel.append(el("div", "err", "找不到 ffmpeg，无法封装视频。请先运行：winget install Gyan.FFmpeg，然后重启 bilidl-web。"));

    const avail = qs.map(q => q.qn);
    const def = Math.max(...avail.filter(x => x <= (status.qn || 64)), Math.min(...avail));
    const box = el("div", "quals");
    for (const q of qs) {
      const b = el("button", "q" + (q.qn === def ? " def" : ""));
      const left = el("div");
      left.append(el("b", "", q.name), el("div", "d", `${q.codec} · ${q.res} · ${Math.round(q.kbps)} kbps`));
      b.append(left, el("span", "s", "约 " + fmtBytes((q.kbps + info.audio_kbps) * 125 * total)));
      b.disabled = !status.ffmpeg;
      b.onclick = () => start(info, status, q, url);
      box.append(b);
    }
    panel.append(box);

    const dm = status.danmaku && status.danmaku_ok;
    const extras = [status.subs !== "off" && "字幕", dm && "弹幕"].filter(Boolean);
    panel.append(el("div", "muted", `保存到 ${status.default_dir}` + (extras.length ? ` · 同时下载${extras.join("和")}` : "")));
    const links = el("div", "links");
    const more = el("button", "link", "更多选项（选分P、目录、字幕…）");
    more.onclick = () => { send("openUI", { url }).catch(e => alert(e.message)); close(); };
    links.append(more);
    panel.append(links);
  }

  async function start(info, status, q, url) {
    const my = session;
    for (const b of panel.querySelectorAll("button.q")) b.disabled = true;
    const params = { bvid: info.bvid, pages: info.pages.map(p => p.page), qn: q.qn, out_dir: status.default_dir,
                     threads: status.threads, subs: status.subs, sub_only: false,
                     danmaku: !!(status.danmaku && status.danmaku_ok) };
    let r;
    try { r = await send("download", { params }); }
    catch (e) { if (my === session) showError(info.title, e.message, url); return; }
    if (my !== session) return;
    renderProgress(info.title, q.name, r.id, my);
  }

  const JOB_TEXT = { queued: "排队中", running: "下载中", done: "完成", partial: "部分失败", failed: "失败", cancelled: "已取消" };

  function renderProgress(title, qname, id, my) {
    frame(title);
    const line = el("div", "muted", `已加入下载队列 · ${qname}`);
    const bar = el("div", "bar"), fill = el("div"); bar.append(fill);
    const stat = el("div", "muted", "");
    const err = el("div", "err", ""); err.hidden = true;
    const links = el("div", "links");
    const view = el("button", "link", "打开 bilidl 查看"); view.onclick = () => send("openUI", {}).catch(() => {});
    links.append(view);
    panel.append(line, bar, stat, err, links);

    async function tick() {
      if (my !== session) return;
      let j;
      try { j = await send("job", { id }); } catch (e) { j = undefined; stat.textContent = e.message; }
      if (my !== session) return;
      if (j === null) { stat.textContent = "任务已在 bilidl 里被移除"; return; }
      if (j) {
        const kept = j.pages.filter(p => p.state !== "skipped");
        const fin = kept.filter(p => p.state === "done" || p.state === "exists").length;
        const pct = j.total ? Math.min(100, j.done / j.total * 100) : 0;
        fill.style.width = (j.status === "done" ? 100 : pct).toFixed(1) + "%";
        bar.className = "bar" + (j.status === "done" ? " done" : ["failed", "partial"].includes(j.status) ? " bad" : "");
        const parts = [JOB_TEXT[j.status] || j.status, pct.toFixed(1) + "%", `${fmtBytes(j.done)} / 约 ${fmtBytes(j.total)}`];
        if (j.status === "running") parts.push(`${(j.speed / 1e6).toFixed(2)} MB/s`);
        if (kept.length > 1) parts.push(`分P ${fin}/${kept.length}`);
        stat.textContent = parts.join(" · ");
        stat.className = j.status === "done" ? "ok" : "muted";
        const e = j.error || j.pages.map(p => p.error).find(Boolean) || "";
        err.hidden = !e; err.textContent = e;
        if (!["queued", "running"].includes(j.status)) return;  // 结束了就不再轮询
      }
      pollTimer = setTimeout(tick, 1000);
    }
    tick();
  }

  fab.onclick = () => { if (panel.hidden) open(); else close(); };
})();
