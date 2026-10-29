// B 站接口（bilidl.py 的 Api / video_meta / playurl / pick_streams 的 JS 版）。在插件页面或 Worker 里运行：
// 请求带上浏览器里的登录 cookie（credentials: "include"，插件有 api.bilibili.com 的 host 权限），不用另外设置 SESSDATA。
import { md5 } from "./md5.js";

export const QN_NAME = { 16: "360P", 32: "480P", 64: "720P", 74: "720P60", 80: "1080P", 112: "1080P+", 116: "1080P60",
                         120: "4K", 125: "HDR", 126: "杜比视界", 127: "8K" };
export const CODEC_ID = { avc: 7, hevc: 12, av1: 13 };
// WBI 签名用的字符重排表（img_key + sub_key 按这个顺序取前 32 位）
const WBI_MIX = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
                 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
                 57, 62, 11, 36, 20, 34, 44, 52];
const WBI_TTL = 3600e3;
const API = "https://api.bilibili.com";

let wbi = { t: 0, key: "" };

async function getJson(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}：${url.split("?")[0]}`);
  const j = await r.json();
  if (j.code) throw new Error(`${j.message || "接口错误"}（${j.code}）`);
  return j.data;
}

export async function nav() {
  const r = await fetch(API + "/x/web-interface/nav", { credentials: "include" });
  const d = (await r.json()).data || {};  // 未登录时 code 是 -101，data 里照样有 wbi_img
  if (d.wbi_img) wbi = { t: Date.now(), key: mixinKey(d.wbi_img) };
  return { login: !!d.isLogin, vip: !!d.vipStatus, uname: d.uname || "" };
}

function mixinKey(w) {
  const raw = [w.img_url, w.sub_url].map(u => u.split("/").pop().split(".")[0]).join("");
  return WBI_MIX.map(i => raw[i]).join("").slice(0, 32);
}

/** 带 WBI 签名（wts + w_rid）的 query 字符串。 */
export async function wbiQuery(params) {
  if (!wbi.key || Date.now() - wbi.t > WBI_TTL) await nav();
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ""))}`).join("&");
  return q + "&w_rid=" + md5(q + wbi.key);
}

/** 从链接里找 BV 号和 ?p=。 */
export function parseTarget(s) {
  const m = /BV[0-9A-Za-z]{10}/.exec(s || "");
  if (!m) return null;
  const p = /[?&]p=(\d+)/.exec(s);
  return { bvid: m[0], page: p ? +p[1] : null };
}

/** 返回 { title, owner, pages: [{ page, part, cid, duration }] }。view 被风控（412）时换带签名的 wbi/view，再不行用 pagelist。 */
export async function videoMeta(bvid) {
  const conv = v => ({ title: v.title, owner: v.owner?.name || "", pages: v.pages.map(p => ({ page: p.page, part: p.part, cid: p.cid, duration: p.duration })) });
  for (const url of [() => `${API}/x/web-interface/view?bvid=${bvid}`, async () => `${API}/x/web-interface/wbi/view?` + await wbiQuery({ bvid })]) {
    try { return conv(await getJson(await url())); } catch { /* 下一个 */ }
  }
  const ps = await getJson(`${API}/x/player/pagelist?bvid=${bvid}`);
  return { title: bvid, owner: "", pages: ps.map(p => ({ page: p.page, part: p.part, cid: p.cid, duration: p.duration })) };
}

export const playurl = (bvid, cid, qn = 127) => getJson(`${API}/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1&qn=${qn}`);

export const allAudio = dash => [...(dash.audio || []), ...(dash.flac?.audio ? [dash.flac.audio] : [])];

/** 和 bilidl.py 的 pick_streams 一样：不超过 qn 的最高清晰度，优先 codec 编码；音频取码率最高的。 */
export function pickStreams(dash, qn, codec = "avc") {
  const ids = [...new Set(dash.video.map(v => v.id))].sort((a, b) => a - b);
  const under = ids.filter(i => i <= qn);
  const chosen = under.length ? Math.max(...under) : ids[0];
  const cands = dash.video.filter(v => v.id === chosen);
  const v = cands.find(x => x.codecid === CODEC_ID[codec]) || cands[0];
  const a = allAudio(dash).sort((x, y) => y.bandwidth - x.bandwidth)[0] || null;
  return [v, a];
}

/** 一个流的全部链接（baseUrl + backupUrl）和用来换域名的模板（第一个 upos-*.bilivideo.com 链接，akamai 的签名不能换域名）。 */
export function streamUrls(s) {
  const urls = [s.baseUrl || s.base_url, ...(s.backupUrl || s.backup_url || [])].filter(Boolean);
  const tmpl = urls.find(u => { const h = new URL(u).hostname; return h.startsWith("upos-") && h.endsWith(".bilivideo.com"); }) || null;
  return { tmpl, urls };
}

/** 一个分P可选的清晰度：[{ qn, name, codecs: [...], res, size（视频 + 音频的估算字节数） }]，高的在前。 */
export function qualities(dash) {
  const a = allAudio(dash).sort((x, y) => y.bandwidth - x.bandwidth)[0];
  const out = new Map();
  for (const v of dash.video) {
    const e = out.get(v.id) || { qn: v.id, name: QN_NAME[v.id] || String(v.id), codecs: [], res: `${v.width}x${v.height}`, size: 0 };
    const c = Object.keys(CODEC_ID).find(k => CODEC_ID[k] === v.codecid) || v.codecs;
    e.codecs.push(c);
    if (c === "avc" || !e.size) e.size = (v.bandwidth + (a?.bandwidth || 0)) / 8 * dash.duration;
    out.set(v.id, e);
  }
  return [...out.values()].sort((x, y) => y.qn - x.qn);
}

// ---------- 文件名（和 bilidl.py 的 output_layout 一样：多P放进以标题命名的文件夹） ----------
const units = s => s.length;  // JS 字符串长度本来就按 UTF-16 计
export const safe = s => s.replace(/[\\/:*?"<>|\r\n]/g, "_").trim();

function clip(s, limit) {
  let out = "";
  for (const ch of s) {
    if (units(out + ch) > limit) break;
    out += ch;
  }
  return out.replace(/[ .]+$/, "");  // Windows 文件名不能以点或空格结尾
}

/** 保存的相对路径（不含扩展名）。单P：标题；多P：标题/P1 分P名。 */
export function outName(title, nPages, page, part) {
  if (nPages <= 1) return clip(safe(title), 120) || "video";
  return (clip(safe(title), 80) || "video") + "/" + (clip(safe(`P${page} ${part}`), 100) || `P${page}`);
}
