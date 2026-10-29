// 只负责图标上的角标：bridge.js 发来每个标签页的文字（领先秒数，或「关」）。
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "badge" || !sender.tab) return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: msg.text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: msg.text === "关" ? "#888" : "#00a1d6" });
});
