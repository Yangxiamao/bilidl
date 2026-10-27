// 所有对本地服务的请求都在这里发：内容脚本运行在 bilibili.com 的源下，直接请求 127.0.0.1
// 会被 CORS 和 Chrome 的私有网络访问限制拦掉；扩展后台有 host 权限，不受这些限制。
"use strict";
const BASE = "http://127.0.0.1:8765";
const NOT_RUNNING = "bilidl 没有运行。请双击「一键启动.bat」，或运行 install-autostart.ps1 设为开机自启，然后再试。";

let token = null;  // 服务每次启动都换 token，收到「token 无效」时重取

async function getToken() {
  if (token) return token;
  let r;
  try { r = await fetch(BASE + "/api/token", { cache: "no-store" }); } catch (e) { throw new Error(NOT_RUNNING); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.token) throw new Error(data.error || "取 token 失败（HTTP " + r.status + "），bilidl 版本是否太旧？");
  return token = data.token;
}

async function api(path, body, retried) {
  const opt = { method: body === undefined ? "GET" : "POST", headers: { "X-Token": await getToken() }, cache: "no-store" };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(BASE + path, opt); } catch (e) { token = null; throw new Error(NOT_RUNNING); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 403 && !retried && /token/.test(data.error || "")) {
    token = null;
    return api(path, body, true);
  }
  if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
  return data;
}

// 把 Chrome 里 B 站的登录状态同步给 bilidl；Chrome 里没登录时不动 bilidl 原有的 cookie
async function syncCookie() {
  const c = await chrome.cookies.get({ url: "https://www.bilibili.com/", name: "SESSDATA" });
  if (!c || !c.value) return null;
  try { return await api("/api/sync_cookie", { sessdata: c.value }); }
  catch (e) { if (e.message === NOT_RUNNING) throw e; return { error: e.message }; }  // 同步失败不影响下载
}

const handlers = {
  async prepare({ url }) {
    const sync = await syncCookie();
    const status = await api("/api/status");
    const info = await api("/api/info", { url });
    return { sync, status, info };
  },
  download({ params }) { return api("/api/download", params); },
  async job({ id }) {
    const { jobs } = await api("/api/jobs");
    return jobs.find(j => j.id === id) || null;
  },
  openUI({ url }) {
    chrome.tabs.create({ url: BASE + "/" + (url ? "?url=" + encodeURIComponent(url) : "") });
    return {};
  },
  async playRule({ on, why }, sender) {
    const tabId = sender.tab && sender.tab.id;
    if (!(tabId > 0)) throw new Error("没有标签页");
    const st = (await chrome.storage.session.get("play" + tabId))["play" + tabId];
    if (on && st && st.until > Date.now()) return { applied: false };  // 刚退回直连，冷却期内不重新打开
    if (on && st && st.on && (await chrome.declarativeNetRequest.getSessionRules({ ruleIds: [tabId] })).length)
      return { applied: true };  // play.js 每 10 秒报一次，已经开着就不动
    await setPlayRule(tabId, on);
    await chrome.storage.session.set({ ["play" + tabId]: { on, why } });
    return { applied: true };
  },
  async playStatus(_msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    const { playAccel = true } = await chrome.storage.local.get("playAccel");
    const st = (await chrome.storage.session.get("play" + tabId))["play" + tabId] || { on: false, why: "checking" };
    const rules = await chrome.declarativeNetRequest.getSessionRules({ ruleIds: [tabId] });
    const on = st.on && rules.length > 0;
    let stats = null;
    if (on) { try { stats = await api("/api/play_stats"); } catch (e) { /* 统计取不到不影响播放 */ } }
    return { pref: playAccel, on, why: on ? "" : st.why, detail: st.detail || "", at: st.at || 0, stats };
  },
};

// ---------- 在线播放加速 ----------
// 把播放器对 upos 节点的 m4s 请求重定向到本机 bilidl-web，由它多线程预读（见 docs/PLAYBACK.md）。
// 规则只加给 play.js 确认过能访问本机服务的标签页（会话规则 + tabIds，规则 id 就用标签页 id）。
const PLAY_RULE = {
  priority: 1,
  action: { type: "redirect", redirect: { regexSubstitution: BASE + "/play/\\0" } },
  condition: { regexFilter: "^https://upos-[a-z0-9-]+\\.(bilivideo\\.com|akamaized\\.net)/[^?]*\\.m4s(\\?.*)?$",
               resourceTypes: ["xmlhttprequest", "media", "other"] },
};

async function setPlayRule(tabId, on) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: on ? [{ ...PLAY_RULE, id: tabId, condition: { ...PLAY_RULE.condition, tabIds: [tabId] } }] : [],
  });
}

chrome.tabs.onRemoved.addListener(tabId => {
  setPlayRule(tabId, false).catch(() => {});
  chrome.storage.session.remove("play" + tabId).catch(() => {});
});

// 重定向过去的请求失败（bilidl 退出、连续出错）时立刻撤掉这个标签页的规则，播放器重试时就直连了。
// 只靠 play.js 每 10 秒探测一次太慢：播放器几秒内重试几次都失败，就会报错并重置播放。
const FALLBACK_MS = 30000;   // 退回直连后 30 秒内不重新打开
const FAIL_LIMIT = 3;        // 偶发错误（5xx、超时、数据不完整）连续这么多次才退回直连
const proxyFails = new Map();  // tabId -> 连续偶发错误次数
const PLAY_FILTER = { urls: [BASE + "/play/*"] };
// 这些错误说明 bilidl 已经退出或连不上，立刻退回直连；其他错误先计数
const SERVER_GONE = new Set(["net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_CLOSED",
                             "net::ERR_EMPTY_RESPONSE", "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_FAILED"]);

// detail 记下触发的错误，面板上显示出来，方便判断原因
async function fallback(tabId, detail) {
  proxyFails.delete(tabId);
  await setPlayRule(tabId, false);
  await chrome.storage.session.set({ ["play" + tabId]: { on: false, why: "proxy-failed", detail, at: Date.now(),
                                                        until: Date.now() + FALLBACK_MS } });
}

function sporadic(tabId, detail) {
  const n = (proxyFails.get(tabId) || 0) + 1;
  proxyFails.set(tabId, n);
  if (n >= FAIL_LIMIT) fallback(tabId, `连续 ${n} 次出错，最后一次：${detail}`).catch(() => {});
}

chrome.webRequest.onErrorOccurred.addListener(d => {
  if (!(d.tabId > 0) || d.url.endsWith("/play/ping") || d.error === "net::ERR_ABORTED") return;  // 跳转时播放器会主动取消请求
  if (SERVER_GONE.has(d.error)) fallback(d.tabId, d.error).catch(() => {});
  else sporadic(d.tabId, d.error);
}, PLAY_FILTER);

chrome.webRequest.onCompleted.addListener(d => {
  if (!(d.tabId > 0) || d.url.endsWith("/play/ping")) return;
  if (d.statusCode < 500) proxyFails.delete(d.tabId);
  else sporadic(d.tabId, "HTTP " + d.statusCode);
}, PLAY_FILTER);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve().then(() => fn(msg, sender)).then(data => reply({ ok: true, data }), e => reply({ ok: false, error: e.message }));
  return true;  // 异步回复
});
