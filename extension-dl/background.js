// 后台（service worker）：
// - bilivideo 的 CDN 不带 Referer 就返回 403，fetch 又不能把 Referer 设成别的网站，所以用 DNR 给本插件自己发出的请求加上；
// - 弹出页的操作转给 offscreen document 里的 Worker（没有就先建一个；浏览器启动时也建，好接着下上次没下完的）；
// - 下完的文件用 chrome.downloads 存到下载目录（没选保存目录时）；
// - 图标角标显示进度。
const REFERER_RULE = {
  id: 1, priority: 1,
  action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: "https://www.bilibili.com/" }] },
  condition: { requestDomains: ["bilivideo.com", "akamaized.net"], initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest", "other"] },
};
chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [REFERER_RULE] });

let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["WORKERS", "BLOBS"],
    justification: "在后台下载视频、写入插件自己的存储，关掉标签页也能继续",
  }).finally(() => { creating = null; });
  await creating;
}

chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(ensureOffscreen);

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.target === "bg") {  // 弹出页 / 设置页发来的操作
    ensureOffscreen().then(() => chrome.runtime.sendMessage({ ...m, target: "offscreen" })).then(() => reply(true), e => reply(String(e)));
    return true;
  }
  if (m?.type === "dl-export") exportDownload(m);
  if (m?.type === "dl-state") badge(m.tasks);
});

async function exportDownload({ id, url, filename }) {
  try {
    const did = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    const { pending = {} } = await chrome.storage.session.get("pending");  // service worker 随时可能被回收，对应关系存起来
    pending[did] = id;
    await chrome.storage.session.set({ pending });
  } catch (e) {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ target: "offscreen", op: "exported", id, ok: false, error: e.message });
  }
}

chrome.downloads.onChanged.addListener(async d => {
  if (!d.state || d.state.current === "in_progress") return;
  const { pending = {} } = await chrome.storage.session.get("pending");
  const id = pending[d.id];
  if (!id) return;
  delete pending[d.id];
  await chrome.storage.session.set({ pending });
  const [item] = await chrome.downloads.search({ id: d.id });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: "offscreen", op: "exported", id, ok: d.state.current === "complete",
                               error: item?.error || d.state.current, path: item?.filename || "" });
});

function badge(tasks) {
  const run = tasks.find(t => t.status === "running" || t.status === "finishing" || t.status === "saving");
  const queued = tasks.filter(t => t.status === "queued").length;
  let text = "";
  if (run) text = run.status === "running" && run.total ? `${Math.floor(run.done / run.total * 100)}%` : "…";
  else if (queued) text = String(queued);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: tasks.some(t => t.status === "error") ? "#f25d8e" : "#00a1d6" });
}
