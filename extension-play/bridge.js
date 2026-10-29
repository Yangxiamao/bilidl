// ISOLATED world 的内容脚本：在页面里的 page.js（MAIN world，拿不到 chrome.* 接口）和插件之间传话。
//   - 把设置（开关、档位）从 chrome.storage 转给 page.js；只有弹出页能改设置，页面发来的事件一律不写 storage；
//   - 弹出页要状态时向 page.js 要一份；
//   - 状态有变化时让后台更新图标上的角标。
const EV = "bilidl-play:";
const DEFAULTS = { playEnabled: true, playProfile: "mid" };
let config = null;
let seq = 0;
const waiting = new Map();  // 请求编号 -> 回调

function push() {
  if (config) document.dispatchEvent(new CustomEvent(EV + "config", {
    detail: JSON.stringify({ enabled: config.playEnabled, profile: config.playProfile }) }));
}

chrome.storage.local.get(DEFAULTS, c => { config = c; push(); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !config) return;
  for (const k in DEFAULTS) if (ch[k]) config[k] = ch[k].newValue ?? DEFAULTS[k];
  push();
});
document.addEventListener(EV + "hello", push);

document.addEventListener(EV + "stats", e => {
  let st;
  try { st = JSON.parse(e.detail); } catch { return; }
  const cb = waiting.get(st.id);
  if (cb) { waiting.delete(st.id); cb(st); }
});

function stats(timeout = 1000) {
  return new Promise(ok => {
    const id = String(++seq);
    waiting.set(id, ok);
    setTimeout(() => { if (waiting.delete(id)) ok(null); }, timeout);
    document.dispatchEvent(new CustomEvent(EV + "get", { detail: id }));
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "stats") return;
  stats().then(reply);
  return true;
});

// 角标：关闭时显示「关」，接管过请求后显示播放器缓冲 + 预读领先的秒数，只在变化时通知后台
let badge = null;
setInterval(async () => {
  if (document.hidden) return;
  const st = await stats();
  if (!st) return;
  let text = "";
  if (!st.enabled) text = "关";
  else if (st.counts.served) {
    const v = st.resources.find(r => r.kind === "video");
    const sec = (st.video?.buffered || 0) + (v?.aheadSec || 0);
    text = sec >= 10 ? String(Math.min(990, Math.round(sec / 10) * 10)) : "⚡";  // 取整到 10 秒，少打扰后台
  }
  if (text !== badge) {
    badge = text;
    chrome.runtime.sendMessage({ type: "badge", text }).catch(() => {});
  }
}, 3000);
