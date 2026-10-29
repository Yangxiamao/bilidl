// 把 B 站 DASH 的视频、音频两个 fMP4（.m4s）合成一个 mp4，相当于 ffmpeg -c copy。不碰 DOM 和文件：读写由调用方传进来，可以离线测。
//
// m4s 的结构是 ftyp、moov（样本表是空的）、sidx（每个分片的大小和时长）、若干 moof + mdat。playurl 的 segment_base 给出
// moov 和 sidx 的范围，先取这一小段就能算出整个输出文件的布局：每个分片原样搬到输出文件里固定的位置，下载到哪一段就直接写到哪里，
// 不需要中间文件，也不需要最后再合并一遍，内存里只有正在下载的分段。
//
// 两种输出：
//   mp4（默认）：ftyp、预留给 moov 的空间、按时间交错的分片。每个 moof 只把类型改成 free（内容留在文件里），下完后扫一遍这些
//               free 生成普通的样本表，写进前面预留的位置（相当于 faststart）；预留的不够就写在文件末尾，和 ffmpeg 一样。
//   fmp4：ftyp、合并后的 moov（带 mvex）、原样的 moof + mdat。不用生成样本表，但有些播放器拖动进度条不好用。

const NON_SYNC = 0x10000;  // sample_flags 里的 sample_is_non_sync_sample

const typeAt = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
const view = u => new DataView(u.buffer, u.byteOffset, u.byteLength);
const u64 = (d, o) => Number(d.getBigUint64(o));

/** 依次给出 [start, end) 里的 box。超出 end 的 box 到此为止（只取了文件开头一段时，后面的 moof 是不完整的）。 */
function* boxes(u, start = 0, end = u.length) {
  const d = view(u);
  for (let o = start; o + 8 <= end;) {
    let size = d.getUint32(o), hl = 8;
    if (size === 1) { if (o + 16 > end) return; size = u64(d, o + 8); hl = 16; } else if (size === 0) size = end - o;
    if (size < hl) throw new Error(`box ${typeAt(u, o + 4)} 大小不对：${size}`);
    if (o + size > end) return;
    yield { type: typeAt(u, o + 4), start: o, body: o + hl, end: o + size };
    o += size;
  }
}
const child = (u, b, type) => { for (const c of boxes(u, b.body, b.end)) if (c.type === type) return c; return null; };
const children = (u, b, type) => [...boxes(u, b.body, b.end)].filter(c => c.type === type);
const raw = (u, b) => u.slice(b.start, b.end);

// ---------- 写 box ----------
class W {
  constructor(n = 256) { this.a = new Uint8Array(n); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    const b = new Uint8Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  u8(v) { this.need(1); this.a[this.n++] = v; return this; }
  u16(v) { this.need(2); view(this.a).setUint16(this.n, v); this.n += 2; return this; }
  u32(v) { this.need(4); view(this.a).setUint32(this.n, v >>> 0); this.n += 4; return this; }
  i32(v) { this.need(4); view(this.a).setInt32(this.n, v); this.n += 4; return this; }
  u64(v) { this.need(8); view(this.a).setBigUint64(this.n, BigInt(v)); this.n += 8; return this; }
  str(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); return this; }
  raw(b) { this.need(b.length); this.a.set(b, this.n); this.n += b.length; return this; }
  zero(k) { this.need(k); this.n += k; return this; }  // a 新分配时就是 0；raw/u8 写过的地方不会再走 zero
  done() { return this.a.slice(0, this.n); }
}

function box(type, ...parts) {
  const w = new W(8 + parts.reduce((s, p) => s + p.length, 0));
  w.u32(0).str(type);
  for (const p of parts) w.raw(p);
  view(w.a).setUint32(0, w.n);
  return w.done();
}
const full = (type, version, flags, body) => box(type, new W(4 + body.length).u8(version).u8(flags >> 16 & 255).u16(flags & 0xffff).raw(body).done());
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

// ---------- 读 init + sidx ----------

/** 解析一个 m4s 开头的 init 和 sidx（u 至少要覆盖到 sidx 的结尾，多了没关系）。返回轨道信息和分片表。 */
export function parseHead(u) {
  let ftyp = null, moov = null, sidx = null;
  for (const b of boxes(u)) {
    if (b.type === "ftyp") ftyp = raw(u, b);
    else if (b.type === "moov") moov = b;
    else if (b.type === "sidx") { sidx = b; break; }
  }
  if (!moov) throw new Error("m4s 开头没有 moov");
  if (!sidx) throw new Error("m4s 开头没有 sidx（或取的范围不够）");
  const d = view(u);
  const traks = children(u, moov, "trak");
  if (traks.length !== 1) throw new Error(`m4s 里有 ${traks.length} 条轨道`);
  const trak = traks[0];
  const tkhd = child(u, trak, "tkhd"), mdia = child(u, trak, "mdia");
  const mdhd = child(u, mdia, "mdhd"), hdlr = child(u, mdia, "hdlr"), minf = child(u, mdia, "minf");
  const stbl = child(u, minf, "stbl"), stsd = child(u, stbl, "stsd");
  const tv = u[tkhd.body], mv = u[mdhd.body];
  const id = d.getUint32(tkhd.body + (tv ? 20 : 12));
  const elst = child(u, trak, "edts") && child(u, child(u, trak, "edts"), "elst");
  // 取第一段非空编辑的起点。hevc 的 m4s 开头还有一段 50 ms 的空编辑（media_time = -1），ffmpeg 也是丢掉它
  let mediaTime = null;
  if (elst) {
    const ev = u[elst.body], n = d.getUint32(elst.body + 4), step = ev ? 20 : 12;
    for (let i = 0, o = elst.body + 8; i < n && mediaTime === null; i++, o += step) {
      const mt = ev ? Number(d.getBigInt64(o + 8)) : d.getInt32(o + 4);
      if (mt !== -1) mediaTime = mt;
    }
  }
  const mvex = child(u, moov, "mvex");
  const trex = mvex && children(u, mvex, "trex").find(t => d.getUint32(t.body + 4) === id);
  const xmhd = [...boxes(u, minf.body, minf.end)].find(b => b.type !== "dinf" && b.type !== "stbl");
  const entry = [...boxes(u, stsd.body + 8, stsd.end)][0];

  // sidx：reference_type 必须是 0（直接指向分片），不支持多级 sidx
  const sv = u[sidx.body];
  const timescale = d.getUint32(sidx.body + 8);
  let o = sidx.body + 12;
  let time = sv ? u64(d, o) : d.getUint32(o);
  const first = sv ? u64(d, o + 8) : d.getUint32(o + 4);
  o += sv ? 16 : 8;
  const count = d.getUint16(o + 2);
  o += 4;
  const frags = [];
  let off = sidx.end + first;
  for (let i = 0; i < count; i++, o += 12) {
    const r = d.getUint32(o);
    if (r >>> 31) throw new Error("不支持多级 sidx");
    const size = r & 0x7fffffff, dur = d.getUint32(o + 4);
    frags.push({ src: off, size, time, dur });
    off += size;
    time += dur;
  }
  return {
    id, handler: typeAt(u, hdlr.body + 8), codec: entry ? entry.type : "",
    timescale: d.getUint32(mdhd.body + (mv ? 20 : 12)), lang: d.getUint16(mdhd.body + (mv ? 32 : 20)),
    sidxTimescale: timescale, mediaTime,
    tkhdVersion: tv, tkhdFlags: d.getUint32(tkhd.body) & 0xffffff, tkhdTail: u.slice(tkhd.body + (tv ? 36 : 24), tkhd.end),
    hdlr: raw(u, hdlr), xmhd: xmhd ? raw(u, xmhd) : new Uint8Array(0), dinf: raw(u, child(u, minf, "dinf")), stsd: raw(u, stsd),
    sgpd: children(u, stbl, "sgpd").map(b => ({ type: typeAt(u, b.body + 4), bytes: raw(u, b) })),
    trex: trex ? { sdi: d.getUint32(trex.body + 8), dur: d.getUint32(trex.body + 12), size: d.getUint32(trex.body + 16), flags: d.getUint32(trex.body + 20) }
               : { sdi: 1, dur: 0, size: 0, flags: 0 },
    ftyp, trak: raw(u, trak), trexBox: trex ? raw(u, trex) : null, mvhd: raw(u, child(u, moov, "mvhd")),
    frags, dataStart: frags.length ? frags[0].src : sidx.end, dataEnd: off,
    sidxDur: time - (frags[0]?.time ?? time), duration: (time - (frags[0]?.time ?? time)) / timescale,
  };
}

// ---------- 布局 ----------

function ftypFor(tracks) {
  const brands = ["isom", "iso2"];
  const c = tracks[0].codec;
  if (c === "avc1" || c === "avc3") brands.push("avc1");
  if (c === "av01") brands.push("av01");
  brands.push("mp41");
  const w = new W().str("isom").u32(0x200);
  brands.forEach(b => w.str(b));
  return box("ftyp", w.done());
}

/** 样本表大小的上限，用来预留 moov 的空间。video 的帧率取 playurl 给的 frameRate，多留 25%。 */
function moovBound(tracks) {
  let n = 4096;
  for (const t of tracks) {
    const rate = t.handler === "vide" ? (t.fps || 120) : t.timescale / (t.trex.dur || 1024);
    const samples = Math.ceil(t.duration * rate * 1.25) + 16 * t.frags.length;
    n += t.stsd.length + t.sgpd.reduce((s, g) => s + g.bytes.length, 0) + 512 + samples * 24 + t.frags.length * 24;
  }
  return n;
}

/**
 * 算输出文件的布局。tracks：parseHead 的结果（视频在前），视频轨可以带 fps。
 * 返回 { format, size, header, pieces, byTrack }：header 写在文件开头；pieces 是每个分片在输入（src）和输出（out）里的位置，
 * 按输出顺序排列；byTrack[i] 是第 i 条轨道的分片（按 src 排列），place() 用。size 是收尾前的文件大小。
 */
export function layout(tracks, { format = "mp4" } = {}) {
  if (format !== "mp4" && format !== "fmp4") throw new Error("format 只能是 mp4 或 fmp4");
  let header, reserve = 0;
  if (format === "mp4") {
    const ftyp = ftypFor(tracks);
    reserve = moovBound(tracks);
    header = new Uint8Array(ftyp.length + 8);
    header.set(ftyp);
    view(header).setUint32(ftyp.length, reserve);
    header.set([0x66, 0x72, 0x65, 0x65], ftyp.length + 4);  // free
  } else header = fmp4Head(tracks);
  // 按分片开始的时间交错，同一时刻视频在前
  const all = tracks.flatMap((t, ti) => t.frags.map((f, i) => ({ t: ti, i, src: f.src, len: f.size, start: f.time / t.sidxTimescale })));
  all.sort((a, b) => a.start - b.start || a.t - b.t);
  let out = header.length + (format === "mp4" ? reserve - 8 : 0);
  all.forEach((p, k) => { p.out = out; p.seq = k + 1; out += p.len; });
  const byTrack = tracks.map((_, ti) => all.filter(p => p.t === ti).sort((a, b) => a.src - b.src));
  return { format, tracks, size: out, header, reserve, moovAt: format === "mp4" ? header.length - 8 : 0, pieces: all, byTrack };
}

/** fmp4 的 moov：两条轨道原样放进去，轨道号改成 1、2，mvex 里各一个 trex。 */
function fmp4Head(tracks) {
  const ftyp = tracks[0].ftyp || ftypFor(tracks);
  const mvhd = tracks[0].mvhd.slice();
  view(mvhd).setUint32(mvhd.length - 4, tracks.length + 1);  // next_track_ID
  // trak 原样放进去，只改轨道号；edts 换成只有一段（去掉开头的空编辑，和 mp4 一样）。分片文件里编辑的长度写 0 表示到结尾
  const traks = tracks.map((t, i) => {
    const kids = [...boxes(t.trak, 8, t.trak.length)].map(c => {
      const b = raw(t.trak, c);
      if (c.type === "tkhd") view(b).setUint32(8 + (b[8] ? 20 : 12), i + 1);
      if (c.type === "edts") return t.mediaTime === null ? null : box("edts", full("elst", 0, 0, new W().u32(1).u32(0).i32(t.mediaTime).u16(1).u16(0).done()));
      return b;
    });
    return box("trak", ...kids.filter(Boolean));
  });
  const trexs = tracks.map((t, i) => full("trex", 0, 0, new W().u32(i + 1).u32(t.trex.sdi).u32(t.trex.dur).u32(t.trex.size).u32(t.trex.flags).done()));
  return concat(ftyp, box("moov", mvhd, box("mvex", ...trexs), ...traks));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 每个分片写入时要改的字节（相对分片开头）：mp4 把 moof 改名 free；fmp4 改 mfhd 的序号和 tfhd 的轨道号。 */
function patches(lay, p) {
  if (lay.format === "mp4") return [[4, new Uint8Array([0x66, 0x72, 0x65, 0x65])]];
  // moof(8) mfhd(8 + 4) 序号；traf(8) tfhd(8 + 4) 轨道号。结构不是这样的话 finish() 检查时会报错
  const seq = new Uint8Array(4), id = new Uint8Array(4);
  view(seq).setUint32(0, p.seq);
  view(id).setUint32(0, p.t + 1);
  return [[20, seq], [44, id]];
}

/**
 * 第 t 条轨道从输入文件 src 处开始的一段数据（下载到的一个分段）应该写到输出文件的哪里。
 * 返回 [[输出位置, 数据], ...]。数据是 bytes 的子视图；要改字节的地方另外复制一份，不改动 bytes。
 * 分片之外的部分（init、sidx）不写。
 */
export function place(lay, t, src, bytes) {
  const ps = lay.byTrack[t], end = src + bytes.length, out = [];
  let lo = 0, hi = ps.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ps[m].src + ps[m].len <= src) lo = m + 1; else hi = m; }
  for (let k = lo; k < ps.length && ps[k].src < end; k++) {
    const p = ps[k];
    const a = Math.max(src, p.src), b = Math.min(end, p.src + p.len);
    let data = bytes.subarray(a - src, b - src);
    for (const [rel, patch] of patches(lay, p)) {
      const s = p.src + rel;  // 这个补丁在输入里的位置
      if (s + patch.length <= a || s >= b) continue;
      if (data.buffer === bytes.buffer) data = data.slice();
      for (let j = 0; j < patch.length; j++) if (s + j >= a && s + j < b) data[s + j - a] = patch[j];
    }
    out.push([p.out + (a - p.src), data]);
  }
  return out;
}

/** 第 t 条轨道输入文件里 src 处的字节在输出文件里的位置（src 必须在某个分片里）。 */
export function outOffset(lay, t, src) {
  const ps = lay.byTrack[t];
  let lo = 0, hi = ps.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ps[m].src <= src) lo = m; else hi = m - 1; }
  return ps[lo].out + (src - ps[lo].src);
}

/** 第 t 条轨道需要下载的输入范围 [start, end)。 */
export const span = (lay, t) => [lay.tracks[t].dataStart, lay.tracks[t].dataEnd];

// ---------- 收尾 ----------

/**
 * 所有分片写完后调用。readAt(位置, 长度) 从输出文件读数据（可以是 async）。
 * mp4：扫一遍改名后的 moof，生成 moov；返回 { writes: [[位置, 数据]], size }，写完后把文件截到 size。
 * fmp4：只检查每个 moof 的结构和补丁是否生效，writes 为空。
 */
export async function finish(lay, readAt) {
  const st = lay.tracks.map(t => ({ t, dur: [], size: [], sync: [], cto: [], chunks: [], groups: new Map(), dts: 0, gaps: 0, negCto: false }));
  for (const p of lay.pieces) {
    const h = await readAt(p.out, 8);
    const size = view(h).getUint32(0), type = typeAt(h, 4);
    const want = lay.format === "mp4" ? "free" : "moof";
    if (type !== want || size < 8 || size > p.len) throw new Error(`输出文件 ${p.out} 处应该是改过的 moof，实际是 ${type}（${size}）`);
    const m = await readAt(p.out, size);
    parseMoof(lay, p, m, st[p.t]);
  }
  if (lay.format === "fmp4") return { writes: [], size: lay.size, gaps: st.map(s => s.gaps) };
  const moov = buildMoov(st);
  const writes = [];
  let size = lay.size;
  if (moov.length === lay.reserve || moov.length + 8 <= lay.reserve) {
    writes.push([lay.moovAt, moov]);
    if (moov.length < lay.reserve) {
      const free = new Uint8Array(8);
      view(free).setUint32(0, lay.reserve - moov.length);
      free.set([0x66, 0x72, 0x65, 0x65], 4);
      writes.push([lay.moovAt + moov.length, free]);
    }
  } else {
    writes.push([lay.size, moov]);  // 预留的不够：放到末尾，前面的预留区保持是 free
    size += moov.length;
  }
  return { writes, size, moovSize: moov.length, reserve: lay.reserve, moovAtEnd: size !== lay.size, gaps: st.map(s => s.gaps) };
}

function parseMoof(lay, p, m, s) {
  const d = view(m), t = s.t;
  const top = { body: 8, end: m.length };
  if (lay.format === "fmp4") {
    const mfhd = child(m, top, "mfhd");
    if (!mfhd || d.getUint32(mfhd.body + 4) !== p.seq) throw new Error(`分片 ${p.seq} 的 mfhd 不对`);
  }
  const trafs = children(m, top, "traf");
  if (trafs.length !== 1) throw new Error(`moof 里有 ${trafs.length} 个 traf`);
  const traf = trafs[0];
  const tfhd = child(m, traf, "tfhd");
  const tf = d.getUint32(tfhd.body) & 0xffffff;
  if (lay.format === "fmp4" && (tfhd.body !== 40 || d.getUint32(tfhd.body + 4) !== p.t + 1)) throw new Error(`分片 ${p.seq} 的 tfhd 不对`);
  let o = tfhd.body + 8, base = null;
  if (tf & 0x1) { base = p.out + (u64(d, o) - p.src); o += 8; }  // base_data_offset 是输入文件里的绝对位置
  if (tf & 0x2) o += 4;
  const defDur = tf & 0x8 ? d.getUint32((o += 4) - 4) : t.trex.dur;
  const defSize = tf & 0x10 ? d.getUint32((o += 4) - 4) : t.trex.size;
  const defFlags = tf & 0x20 ? d.getUint32((o += 4) - 4) : t.trex.flags;
  if (base === null) base = p.out;  // default-base-is-moof，或者都没写（只有一个 traf 时也是 moof 开头）
  const tfdt = child(m, traf, "tfdt");
  if (tfdt) {
    const bt = m[tfdt.body] ? u64(d, tfdt.body + 4) : d.getUint32(tfdt.body + 4);
    if (bt !== s.dts) s.gaps++;  // 普通 mp4 的 stts 表达不了空隙；B 站的分片是连续的，这里只统计
    s.dts = bt;
  }
  let next = null;  // 没写 data_offset 的 trun 紧接着上一个 trun 的数据
  for (const tr of children(m, traf, "trun")) {
    const v = m[tr.body], f = d.getUint32(tr.body) & 0xffffff, n = d.getUint32(tr.body + 4);
    let q = tr.body + 8;
    let pos = f & 0x1 ? base + d.getInt32((q += 4) - 4) : (next ?? base);
    const first = f & 0x4 ? d.getUint32((q += 4) - 4) : null;
    let run = 0;
    for (let i = 0; i < n; i++) {
      const dur = f & 0x100 ? d.getUint32((q += 4) - 4) : defDur;
      const size = f & 0x200 ? d.getUint32((q += 4) - 4) : defSize;
      let flags = f & 0x400 ? d.getUint32((q += 4) - 4) : defFlags;
      if (i === 0 && first !== null) flags = first;
      const cto = f & 0x800 ? (v ? d.getInt32((q += 4) - 4) : d.getUint32((q += 4) - 4)) : 0;
      s.dur.push(dur); s.size.push(size); s.sync.push(!(flags & NON_SYNC)); s.cto.push(cto);
      if (cto < 0) s.negCto = true;
      s.dts += dur;
      run += size;
    }
    if (pos < p.out || pos + run > p.out + p.len) throw new Error(`分片 ${p.seq} 的样本数据超出了分片范围`);
    if (n) s.chunks.push([pos, n]);
    next = pos + run;
  }
  // 样本分组（AAC 的 roll）：只保留 moov 里有对应 sgpd 的，组号是片内的（> 0x10000）就整个丢掉
  for (const g of children(m, traf, "sbgp")) {
    const gv = m[g.body], type = typeAt(m, g.body + 4);
    if (!t.sgpd.some(x => x.type === type)) continue;
    let q = g.body + 8 + (gv ? 4 : 0);
    const n = d.getUint32(q);
    q += 4;
    const list = s.groups.get(type) ?? [];
    if (list === null) continue;
    for (let i = 0; i < n; i++, q += 8) {
      const cnt = d.getUint32(q), gdi = d.getUint32(q + 4);
      if (gdi > 0x10000) { s.groups.set(type, null); break; }
      const last = list[list.length - 1];
      if (last && last[1] === gdi) last[0] += cnt; else list.push([cnt, gdi]);
    }
    if (s.groups.get(type) !== null) s.groups.set(type, list);
  }
}

function rle(vals) {
  const out = [];
  for (const v of vals) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++; else out.push([1, v]);
  }
  return out;
}

const gcd = (a, b) => b ? gcd(b, a % b) : a;

function buildMoov(st) {
  // 和 ffmpeg 一样，影片时间刻度取各轨道的最小公倍数（16000 和 44100 是 7056000），时长不会因为取整差几毫秒
  let ts = st.reduce((a, s) => a / gcd(a, s.t.timescale) * s.t.timescale, 1);
  if (ts > 0xffffffff) ts = 1000;
  const traks = [];
  let movieDur = 0;
  st.forEach((s, i) => {
    const t = s.t, id = i + 1;
    let mediaDur = s.dur.reduce((a, b) => a + b, 0);
    // 最后一个样本按 sidx 的总时长截齐（音频最后一帧常常只有一部分有效），ffmpeg 也是这样
    const want = Math.round(t.sidxDur * t.timescale / t.sidxTimescale), extra = mediaDur - want;
    if (s.dur.length && extra > 0 && extra < s.dur[s.dur.length - 1]) { s.dur[s.dur.length - 1] -= extra; mediaDur = want; }
    const dur = Math.round(mediaDur / t.timescale * ts);
    movieDur = Math.max(movieDur, dur);
    const tw = new W();
    const big = dur > 0xffffffff;
    if (big) tw.u64(0).u64(0).u32(id).u32(0).u64(dur); else tw.u32(0).u32(0).u32(id).u32(0).u32(dur);
    tw.raw(t.tkhdTail);
    const tkhd = full("tkhd", big ? 1 : 0, t.tkhdFlags, tw.done());
    const parts = [tkhd];
    if (t.mediaTime !== null) {  // 和 ffmpeg 一样：一段编辑，长度是整个媒体时长
      const e = new W().u32(1);
      if (big || t.mediaTime > 0x7fffffff) e.u64(dur).u64(t.mediaTime); else e.u32(dur).i32(t.mediaTime);
      e.u16(1).u16(0);
      parts.push(box("edts", full("elst", big || t.mediaTime > 0x7fffffff ? 1 : 0, 0, e.done())));
    }
    const mbig = mediaDur > 0xffffffff;
    const mw = new W();
    if (mbig) mw.u64(0).u64(0).u32(t.timescale).u64(mediaDur); else mw.u32(0).u32(0).u32(t.timescale).u32(mediaDur);
    mw.u16(t.lang).u16(0);
    const mdhd = full("mdhd", mbig ? 1 : 0, 0, mw.done());
    parts.push(box("mdia", mdhd, t.hdlr, box("minf", t.xmhd, t.dinf, stbl(s))));
    traks.push(box("trak", ...parts));
  });
  const big = movieDur > 0xffffffff;
  const mvhd = big ? new W().u64(0).u64(0).u32(ts).u64(movieDur) : new W().u32(0).u32(0).u32(ts).u32(movieDur);
  mvhd.u32(0x10000).u16(0x100).zero(10);
  MATRIX.forEach(x => mvhd.u32(x));
  mvhd.zero(24).u32(st.length + 1);
  return box("moov", full("mvhd", big ? 1 : 0, 0, mvhd.done()), ...traks);
}

function stbl(s) {
  const t = s.t, n = s.size.length;
  const parts = [t.stsd];
  const stts = rle(s.dur), w1 = new W(8 + stts.length * 8).u32(stts.length);
  stts.forEach(([c, v]) => w1.u32(c).u32(v));
  parts.push(full("stts", 0, 0, w1.done()));
  if (s.cto.some(c => c !== 0)) {
    const ctts = rle(s.cto), w = new W(8 + ctts.length * 8).u32(ctts.length);
    ctts.forEach(([c, v]) => w.u32(c).i32(v));
    parts.push(full("ctts", s.negCto ? 1 : 0, 0, w.done()));
  }
  if (s.sync.some(x => !x)) {
    const keys = [];
    s.sync.forEach((x, i) => { if (x) keys.push(i + 1); });
    const w = new W(8 + keys.length * 4).u32(keys.length);
    keys.forEach(k => w.u32(k));
    parts.push(full("stss", 0, 0, w.done()));
  }
  // 一个 trun 一个 chunk
  const stsc = [];
  s.chunks.forEach(([, cnt], i) => { if (!stsc.length || stsc[stsc.length - 1][1] !== cnt) stsc.push([i + 1, cnt]); });
  const w2 = new W(8 + stsc.length * 12).u32(stsc.length);
  stsc.forEach(([first, cnt]) => w2.u32(first).u32(cnt).u32(1));
  parts.push(full("stsc", 0, 0, w2.done()));
  const same = n > 0 && s.size.every(x => x === s.size[0]);
  const w3 = new W(12 + (same ? 0 : n * 4)).u32(same ? s.size[0] : 0).u32(n);
  if (!same) s.size.forEach(x => w3.u32(x));
  parts.push(full("stsz", 0, 0, w3.done()));
  const co64 = s.chunks.some(([pos]) => pos > 0xffffffff);
  const w4 = new W(8 + s.chunks.length * 8).u32(s.chunks.length);
  s.chunks.forEach(([pos]) => co64 ? w4.u64(pos) : w4.u32(pos));
  parts.push(full(co64 ? "co64" : "stco", 0, 0, w4.done()));
  for (const g of t.sgpd) {
    const list = s.groups.get(g.type);
    if (!list) continue;
    parts.push(g.bytes);
    const w = new W().str(g.type).u32(list.length);
    list.forEach(([c, i]) => w.u32(c).u32(i));
    parts.push(full("sbgp", 0, 0, w.done()));
  }
  return box("stbl", ...parts);
}
