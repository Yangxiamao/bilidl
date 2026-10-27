// 在线播放加速：确认这个页面能访问本机的 bilidl-web 后，请后台只为这个标签页打开 m4s 重定向。
// B 站播放器在 Worker 里用 XHR 取视频分段，所以用 declarativeNetRequest 在网络层重定向，不改页面代码。
// 必须先从页面这边试一次：Chrome 的「本地网络访问」要用户允许，没允许时重定向过去的请求会失败，视频就放不出来。
"use strict";
(() => {
  const PING = "http://127.0.0.1:8765/play/ping";
  let sent = null;  // 上次告诉后台的状态，变了才再发
  let busy = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function lnaState() {
    for (const name of ["local-network-access", "loopback-network"]) {
      try { return (await navigator.permissions.query({ name })).state; } catch (e) { /* 这个版本的 Chrome 没有这个权限名 */ }
    }
    return "unknown";
  }

  function report(on, why) {
    const key = on + "|" + why;
    // 开启状态每次都报：后台可能因为代理出错退回了直连，冷却期过后要靠这里重新打开
    if (key === sent && !on) return;
    sent = key;
    chrome.runtime.sendMessage({ type: "playRule", on, why }).then(r => {
      if (!(r && r.ok && r.data.applied)) sent = null;  // 后台在退回直连后的冷却期里，下次检查再发
    }, () => {});  // 扩展重新加载后会失败，刷新页面即可
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      const { playAccel = true } = await chrome.storage.local.get("playAccel");
      if (!playAccel) return report(false, "off");
      // 第一次访问时 Chrome 会弹出「是否允许访问本地网络」的提示，用户点之前 fetch 一直挂着
      const ping = fetch(PING, { cache: "no-store" }).then(r => r.ok, () => false);
      if (await Promise.race([ping, sleep(3000).then(() => "slow")]) === "slow")
        report(false, (await lnaState()) === "prompt" ? "lna-prompt" : "checking");
      if (await ping) return report(true, "");
      report(false, (await lnaState()) === "denied" ? "lna-denied" : "not-running");
    } finally {
      busy = false;
    }
  }

  check();
  setInterval(check, 10000);  // bilidl-web 中途退出时，10 秒内撤掉重定向，播放器回到直连
  chrome.storage.onChanged.addListener(c => { if (c.playAccel) check(); });
})();
