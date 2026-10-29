// 合成出来的 mp4 能不能拖动进度条：无头 Chrome 的 <video> 打开本地文件，依次跳到 10% / 50% / 90% / 99%，
// 每次要在 5 秒内触发 seeked 并且有画面（readyState ≥ 2）；再用 ffmpeg 在同样的位置各解一帧。
// 用法: node tests/dl_seek_test.mjs <文件.mp4> [...]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CDP, evaluate } from "./cdp.mjs";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const files = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POINTS = [0.1, 0.5, 0.9, 0.99];

const SEEK_JS = `async (points) => {
  const v = document.createElement("video");
  v.muted = true;
  v.src = location.href;
  document.body.append(v);
  await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error("加载失败 " + (v.error && v.error.code))); setTimeout(() => bad(new Error("加载超时")), 15000); });
  const out = { duration: v.duration, w: v.videoWidth, h: v.videoHeight, seeks: [] };
  for (const p of points) {
    const t0 = performance.now();
    v.currentTime = v.duration * p;
    const ok = await new Promise(r => { v.onseeked = () => r(true); setTimeout(() => r(false), 5000); });
    if (ok && v.readyState < 2) await new Promise(r => { v.oncanplay = r; setTimeout(r, 3000); });
    out.seeks.push({ at: p, ok, t: +v.currentTime.toFixed(2), ms: Math.round(performance.now() - t0), ready: v.readyState });
  }
  return out;
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bilidl-seek-"));
const child = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run",
  "--mute-audio", "--allow-file-access-from-files", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const exited = new Promise(r => child.on("exit", r));
const cdp = new CDP(child);
let bad = 0;
try {
  for (const f of files) {
    console.log("==", path.basename(f), `${(fs.statSync(f).size / 1e9).toFixed(2)} GB`);
    // 直接打开 file:// 的 mp4，Chrome 会用自己的播放页；在这个页面里另建一个 <video> 来控制
    const { targetId } = await cdp.send("Target.createTarget", { url: pathToFileURL(f).href });
    const sid = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await sleep(1500);
    try {
      const r = await evaluate(cdp, sid, `(${SEEK_JS})(${JSON.stringify(POINTS)})`, 120000);
      const okAll = r.seeks.every(s => s.ok && s.ready >= 2 && Math.abs(s.t - r.duration * s.at) < 6);
      if (!okAll) bad++;
      console.log(`  ${okAll ? "✓" : "✗"} Chrome <video>：${r.w}x${r.h}，${r.duration.toFixed(1)} 秒；` + r.seeks.map(s => `${s.at * 100}% → ${s.t}s（${s.ms} ms${s.ok ? "" : "，没有 seeked"}）`).join("，"));
    } catch (e) {
      bad++;
      console.log("  ✗ Chrome <video>：", e.message);
    }
    await cdp.send("Target.closeTarget", { targetId });
    const dur = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" });
    const res = POINTS.map(p => {
      const t0 = Date.now();
      try {
        const err = execFileSync("ffmpeg", ["-v", "error", "-ss", String(dur * p), "-i", f, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { p, ok: !err.trim(), ms: Date.now() - t0 };
      } catch (e) { return { p, ok: false, ms: Date.now() - t0, err: String(e.stderr).slice(0, 100) }; }
    });
    if (!res.every(r => r.ok)) bad++;
    console.log(`  ${res.every(r => r.ok) ? "✓" : "✗"} ffmpeg -ss：` + res.map(r => `${r.p * 100}% ${r.ms} ms${r.ok ? "" : " " + r.err}`).join("，"));
  }
} finally {
  child.kill();
  await exited;
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(bad ? `\n${bad} 项失败` : "\n全部通过");
process.exit(bad ? 1 : 0);
