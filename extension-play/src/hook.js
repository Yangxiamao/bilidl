// 在页面里接管播放器的视频分段请求（MAIN world、document_start，早于播放器的脚本）。
// B 站播放器在主线程用 XHR（responseType = arraybuffer，带 Range: bytes=a-b）取 .m4s 分段。这里继承 XMLHttpRequest，
// 在 send 里把认得出的请求交给 Engine，拿到数据后在实例上伪造 readyState / status / response 并按原生顺序派发事件。
// 认不出的请求（别的 responseType、没有 a-b 形式的 Range、不是 upos 的 m4s、同步请求）一律原样发出；
// 接管过程中出任何错都改发原请求，等于退回直连。播放器以后改成 fetch 或 Worker 时，这里碰不到，自然就是直连。
import { Engine, PROFILES } from "./engine.js";

const RANGE = /^bytes=(\d+)-(\d+)$/;
const EV = "bilidl-play:";  // 和 bridge.js（ISOLATED world）通信用的事件前缀，detail 一律是 JSON 字符串

export function install(win) {
  const doc = win.document;
  const engine = new Engine({ fetch: win.fetch.bind(win) });
  const counts = { served: 0, passed: 0, fallback: 0, aborted: 0 };
  const passedSamples = [];  // 最近几个没接管的 m4s 请求（域名、responseType、Range），排查用
  let enabled = true;  // bridge 读出设置前按开启处理（几毫秒，早于播放器的第一个请求）
  let lastErr = "";
  const Native = win.XMLHttpRequest;
  const S = new WeakMap();  // xhr -> { url, async, range, method, ctl, faked }
  const OVERRIDES = ["readyState", "status", "statusText", "response", "responseURL", "getResponseHeader", "getAllResponseHeaders"];

  const fake = (xhr, props) => {
    for (const k in props) Object.defineProperty(xhr, k, { configurable: true, get: () => props[k] });
    S.get(xhr).faked = true;
  };
  const unfake = xhr => {
    for (const k of OVERRIDES) delete xhr[k];
    S.get(xhr).faked = false;
  };
  const fire = (xhr, type, n) => xhr.dispatchEvent(n == null ? new Event(type)
    : new ProgressEvent(type, { lengthComputable: true, loaded: n, total: n }));

  class XMLHttpRequest extends Native {
    open(method, url, async) {
      let s = S.get(this);
      if (!s) S.set(this, s = {});
      if (s.ctl) {  // 和原生一样：重新 open 会悄悄中止进行中的请求，不派发事件
        s.ctl.abort();
        s.ctl = null;
      }
      if (s.faked) unfake(this);
      let abs = "";
      try { abs = new URL(String(url), doc.baseURI).href; } catch {}
      Object.assign(s, { method: String(method).toUpperCase(), url: abs, async: arguments.length < 3 || !!async, range: null });
      return super.open(...arguments);
    }

    setRequestHeader(k, v) {
      const s = S.get(this);
      if (s && String(k).toLowerCase() === "range") s.range = String(v).trim();
      return super.setRequestHeader(k, v);
    }

    abort() {
      const s = S.get(this);
      if (!s || !s.ctl) return super.abort();
      s.ctl.abort();
      s.ctl = null;
      counts.aborted++;
      fake(this, { readyState: 4, status: 0, statusText: "", response: null, responseURL: "" });
      fire(this, "readystatechange");
      fire(this, "abort", 0);
      fire(this, "loadend", 0);
      fake(this, { readyState: 0, status: 0, statusText: "", response: null, responseURL: "" });
    }

    send(body) {
      const s = S.get(this);
      const m = s && enabled && s.async && s.method === "GET" && this.responseType === "arraybuffer" &&
        RANGE.exec(s.range || "");
      if (!m || !Engine.accepts(s.url)) {
        if (s && /\.m4s$/.test(s.url.split("?")[0])) {  // 只看路径：统计上报的网址参数里也会带 .m4s
          counts.passed++;
          let host = "";
          try { host = new URL(s.url).hostname; } catch {}
          passedSamples.push(`${host} ${s.method} ${this.responseType || "text"} ${s.range || "无 Range"}${enabled ? "" : "（已关闭）"}`);
          if (passedSamples.length > 5) passedSamples.shift();
        }
        return super.send(body);
      }
      const a = +m[1], b = +m[2];
      if (b < a) return super.send(body);
      const ctl = s.ctl = new AbortController();
      let timer;
      if (this.timeout > 0) {
        // 和原生一样：超过 xhr.timeout 就派发 timeout 事件（播放器靠它换节点重试）
        timer = setTimeout(() => {
          if (s.ctl !== ctl) return;
          ctl.abort();
          s.ctl = null;
          fake(this, { readyState: 4, status: 0, statusText: "", response: null, responseURL: "" });
          fire(this, "readystatechange");
          fire(this, "timeout", 0);
          fire(this, "loadend", 0);
        }, this.timeout);
      }
      queueMicrotask(() => s.ctl === ctl && fire(this, "loadstart", 0));
      engine.request(s.url, a, b, ctl.signal).then(({ data, start, end, size }) => {
        clearTimeout(timer);
        if (s.ctl !== ctl) return;
        s.ctl = null;
        counts.served++;
        const n = data.byteLength;
        const hdr = { "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(n), "content-type": "video/mp4" };
        const head = {
          status: 206, statusText: "Partial Content", responseURL: s.url,
          getResponseHeader: k => hdr[String(k).toLowerCase()] ?? null,
          getAllResponseHeaders: () => Object.entries(hdr).map(([k, v]) => `${k}: ${v}\r\n`).join(""),
        };
        fake(this, { ...head, readyState: 2, response: null });
        fire(this, "readystatechange");
        fake(this, { ...head, readyState: 3, response: null });
        fire(this, "readystatechange");
        fire(this, "progress", n);
        fake(this, { ...head, readyState: 4, response: data });
        fire(this, "readystatechange");
        fire(this, "load", n);
        fire(this, "loadend", n);
      }, e => {
        clearTimeout(timer);
        if (s.ctl !== ctl) return;  // 播放器已经取消或超时
        s.ctl = null;
        counts.fallback++;
        lastErr = String(e && e.message || e);
        engine.log("退回直连：" + lastErr);
        try {
          super.send(body);
        } catch (e2) {
          engine.log("改发原请求也失败了：" + (e2 && e2.message || e2));
          fake(this, { readyState: 4, status: 0, statusText: "", response: null, responseURL: "" });
          fire(this, "readystatechange");
          fire(this, "error", 0);
          fire(this, "loadend", 0);
        }
      });
    }
  }
  win.XMLHttpRequest = XMLHttpRequest;

  // ---------- 和 bridge.js 通信：设置从 bridge 来，状态按需回给它 ----------
  const send = (type, obj) => doc.dispatchEvent(new CustomEvent(EV + type, { detail: JSON.stringify(obj) }));
  doc.addEventListener(EV + "config", e => {
    let c;
    try { c = JSON.parse(e.detail); } catch { return; }
    if (typeof c.enabled === "boolean" && c.enabled !== enabled) {
      enabled = c.enabled;
      if (!enabled) engine.clear();
    }
    if (c.profile && PROFILES[c.profile]) engine.setProfile(c.profile);
  });
  doc.addEventListener(EV + "get", e => {
    const v = doc.querySelector("video");
    let buffered = null;
    if (v) {
      for (let i = 0; i < v.buffered.length; i++)
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.currentTime <= v.buffered.end(i)) buffered = v.buffered.end(i) - v.currentTime;
    }
    send("stats", { id: e.detail, enabled, counts, passedSamples, lastErr, ...engine.stats(),
                    video: v && { t: v.currentTime, rate: v.playbackRate, paused: v.paused, buffered } });
  });
  send("hello", {});
  return { engine, counts };
}
