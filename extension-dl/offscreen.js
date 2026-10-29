// offscreen document：只是 Worker 的宿主，加上 Worker 做不了的两件事——转发消息（Worker 里没有 chrome.runtime），
// 以及给下完的 OPFS 文件建 blob URL，交给后台用 chrome.downloads 保存。关掉所有标签页也会一直在，直到没有任务时自己关掉。
const worker = new Worker("src/worker.js", { type: "module" });
const blobs = new Map();  // 任务 id -> blob URL
let idleTimer = null;
const send = m => chrome.runtime.sendMessage(m).catch(() => {});  // 弹出页没开时没人接，没关系

worker.onmessage = async e => {
  const m = e.data;
  if (m.type === "export") {
    try {
      const f = await (await (await navigator.storage.getDirectory()).getFileHandle(m.opfs)).getFile();
      const url = URL.createObjectURL(f);
      blobs.set(m.id, url);
      send({ type: "dl-export", id: m.id, url, filename: m.filename });
    } catch (err) {
      worker.postMessage({ op: "exported", id: m.id, ok: false, error: err.message });
    }
    return;
  }
  if (m.type === "idle") {  // 没有要下的任务了：等一会儿，还是没有就关掉自己（后台下次需要时再建）
    clearTimeout(idleTimer);
    if (!m.busy && !blobs.size) idleTimer = setTimeout(() => window.close(), 60000);
    return;
  }
  send(m);
};

chrome.runtime.onMessage.addListener(m => {
  if (m?.target !== "offscreen") return;
  clearTimeout(idleTimer);
  if (m.op === "exported" && blobs.has(m.id)) {
    URL.revokeObjectURL(blobs.get(m.id));
    blobs.delete(m.id);
  }
  worker.postMessage(m);
});
