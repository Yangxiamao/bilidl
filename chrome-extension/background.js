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
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve().then(() => fn(msg, sender)).then(data => reply({ ok: true, data }), e => reply({ ok: false, error: e.message }));
  return true;  // 异步回复
});
