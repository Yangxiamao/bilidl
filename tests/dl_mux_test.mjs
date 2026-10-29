// 下载插件的 mp4 合成（extension-dl/src/mux.js）离线验收：和 ffmpeg -c copy 的输出比较。
// 样本目录里每组是 <名字>.video.m4s、<名字>.audio.m4s、<名字>.ref.mp4（用 bilidl.py 下载、ffmpeg -c copy 合成的参考）。
// 按 1 MB 分段、打乱顺序写进输出文件（模拟并发下载），收尾后用 ffprobe / ffmpeg 比较：
//   每个流的 packet 数据哈希（ffmpeg -f streamhash）、每个 packet 的 pts/dts/时长/大小/关键帧、流的时长和帧数；完整解码一遍不报错。
// 用法: node tests/dl_mux_test.mjs <样本目录> [名字...] [--fmp4] [--no-decode] [--keep]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseHead, layout, place, span, finish } from "../extension-dl/src/mux.js";

const argv = process.argv.slice(2);
const args = argv.filter(a => !a.startsWith("--"));
const DIR = args[0];
const FORMATS = argv.includes("--fmp4") ? ["fmp4"] : argv.includes("--both") ? ["mp4", "fmp4"] : ["mp4"];
const DECODE = !argv.includes("--no-decode");
const KEEP = argv.includes("--keep");
const CHUNK = 1 << 20;
const names = args.length > 1 ? args.slice(1) : [...new Set(fs.readdirSync(DIR).filter(f => f.endsWith(".ref.mp4")).map(f => f.slice(0, -8)))];

const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 1 << 30 });

function readHead(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(Math.min(1 << 20, fs.fstatSync(fd).size));
  fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function mux(name, format) {
  const inputs = ["video", "audio"].map(k => path.join(DIR, `${name}.${k}.m4s`));
  const tracks = inputs.map(f => parseHead(readHead(f)));
  tracks[0].fps = 62.5;
  const lay = layout(tracks, { format });
  const out = path.join(DIR, `${name}.${format}.out.mp4`);
  const fd = fs.openSync(out, "w+");
  fs.ftruncateSync(fd, lay.size);
  fs.writeSync(fd, lay.header, 0, lay.header.length, 0);
  // 所有分段打乱顺序，模拟并发下载完成的先后
  const jobs = [];
  tracks.forEach((t, ti) => {
    const [a, b] = span(lay, ti);
    for (let s = a; s < b; s += CHUNK) jobs.push([ti, s, Math.min(s + CHUNK, b)]);
  });
  const ins = inputs.map(f => fs.openSync(f, "r"));
  for (const [ti, s, e] of shuffle(jobs)) {
    const buf = Buffer.alloc(e - s);
    fs.readSync(ins[ti], buf, 0, buf.length, s);
    for (const [pos, data] of place(lay, ti, s, new Uint8Array(buf.buffer, buf.byteOffset, buf.length))) fs.writeSync(fd, data, 0, data.length, pos);
  }
  ins.forEach(f => fs.closeSync(f));
  const t0 = performance.now();
  const fin = await finish(lay, (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return new Uint8Array(b.buffer, b.byteOffset, len); });
  for (const [pos, data] of fin.writes) fs.writeSync(fd, data, 0, data.length, pos);
  fs.ftruncateSync(fd, fin.size);
  fs.closeSync(fd);
  const ms = performance.now() - t0;
  const info = format === "mp4" ? `moov ${(fin.moovSize / 1024).toFixed(0)} KB / 预留 ${(fin.reserve / 1024).toFixed(0)} KB${fin.moovAtEnd ? "（放到了末尾）" : ""}` : "";
  console.log(`  ${format}: ${(fin.size / 1e6).toFixed(1)} MB，${tracks[0].frags.length}+${tracks[1].frags.length} 个分片，收尾 ${ms.toFixed(0)} ms ${info}，tfdt 不连续 ${fin.gaps}`);
  return out;
}

const streamhash = f => run("ffmpeg", ["-v", "error", "-i", f, "-map", "0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"]).trim();
// fmp4 没有 edit list 的结尾裁剪信息：ffmpeg 给参考文件最后一个音频包加的 side data（行尾多一个逗号）它没有，比较时去掉
const packets = (f, loose) => run("ffprobe", ["-v", "error", "-show_entries", "packet=stream_index,pts,dts,duration,size,flags", "-of", "csv=p=0", f])
  .trim().split(/\r?\n/).map(l => loose ? l.replace(/,$/, "") : l).sort().join("\n");
const streams = f => JSON.parse(run("ffprobe", ["-v", "error", "-show_entries",
  "stream=index,codec_name,profile,width,height,start_time,duration,nb_frames,sample_rate,channels:format=duration", "-of", "json", f]));

let failed = 0;
function check(label, a, b) {
  const ok = a === b;
  if (!ok) failed++;
  console.log(`    ${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n      参考: ${String(a).slice(0, 300)}\n      输出: ${String(b).slice(0, 300)}`}`);
}

for (const name of names) {
  const ref = path.join(DIR, `${name}.ref.mp4`);
  console.log(`== ${name}`);
  const refHash = streamhash(ref), refSt = streams(ref);
  for (const format of FORMATS) {
    const loose = format === "fmp4";  // fmp4 的 moov 里不记帧数（nb_frames）
    const refPk = packets(ref, loose);
    const out = await mux(name, format);
    check("每个流的 packet 数据哈希", refHash, streamhash(out));
    const pk = packets(out, loose);
    check(`每个 packet 的 pts/dts/时长/大小/关键帧（${refPk.split("\n").length} 个）`, refPk, pk);
    const st = streams(out);
    const strip = x => loose ? { ...x, nb_frames: undefined } : x;
    for (let i = 0; i < refSt.streams.length; i++) check(`流 ${i} 的参数`, JSON.stringify(strip(refSt.streams[i])), JSON.stringify(strip(st.streams[i])));
    console.log(`    时长 参考 ${refSt.format.duration} / 输出 ${st.format.duration}`);
    if (DECODE) {
      const t0 = Date.now();
      let err = "";
      try { err = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { err = String(e.stderr || e); }
      check(`完整解码无报错（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`, "", err.trim());
    }
    if (!KEEP) fs.rmSync(out);
  }
}
console.log(failed ? `\n${failed} 项不一致` : "\n全部一致");
process.exit(failed ? 1 : 0);
