// 挑节点：B 站 CDN 的节点列表和按实测速度排序，播放加速插件和以后的下载插件共用（打包时复制进各插件，见 tools/build_ext.mjs）。
// FAST_HOSTS 和「连续失败 3 次冷却 60 秒」与 bilidl.py（下载）一致，改一边时记得同步另一边；按实测速度排序和 pick
//（按速度加权）只有插件用，原理和实测见 docs/PLAY_EXTENSION.md。

// upos 链接的签名在 query 里，换域名照样有效（akamai 的链接也一样）。节点会下线、速度也常变，这里的顺序只是初始值
export const FAST_HOSTS = ["upos-sz-mirror08ct.bilivideo.com",
                           "upos-sz-mirrorhwb.bilivideo.com",
                           "upos-sz-mirrorhw.bilivideo.com",
                           "upos-sz-mirroralib.bilivideo.com",
                           "upos-sz-mirroraliov.bilivideo.com"];
export const HOST_FAIL_LIMIT = 3, HOST_COOLDOWN = 60;  // 节点连续失败 3 次就降到末尾，冷却 60 秒
export const UPOS = /^upos-[a-z0-9-]+\.(bilivideo\.com|akamaized\.net)$/;

export function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

export function onHost(u, host) {
  const x = new URL(u);
  x.hostname = host;
  return x.href;
}

export const isAkamai = u => hostOf(u).endsWith(".akamaized.net");

export const nowSec = () => performance.now() / 1000;

/** 各节点的连续失败次数、冷却时间和实测速度（单个请求的速度，字节/秒）。 */
export class HostHealth {
  constructor(log = () => {}, now = nowSec) {
    this.log = log;
    this.now = now;
    this.fails = new Map();  // host -> 连续失败次数
    this.cool = new Map();   // host -> 冷却到期时间
    this.speed = new Map();  // host -> 单个请求速度的滑动平均
  }

  /** 可用节点按原顺序排列；冷却中的节点只在全部节点都冷却时才用。 */
  usable(urls) {
    const now = this.now();
    const good = urls.filter(u => (this.cool.get(hostOf(u)) || 0) <= now);
    return good.length ? good : [...urls];
  }

  /** 可用节点按实测速度从快到慢排列。还没测过的节点：unknownFirst 时排在最前，好让每个节点都被试到；
   *  否则排在测过的之后（急用的请求不拿没测过的节点冒险）。 */
  ranked(urls, unknownFirst = true) {
    const unknown = unknownFirst ? Infinity : -1;
    const sp = u => this.speed.has(hostOf(u)) ? this.speed.get(hostOf(u)) : unknown;
    return this.usable(urls).map((u, i) => [u, i]).sort((a, b) => sp(b[0]) - sp(a[0]) || a[1] - b[1]).map(x => x[0]);
  }

  ok(u, nbytes = 0, sec = 0) {
    const h = hostOf(u);
    this.fails.set(h, 0);
    if (nbytes && sec > 0) {
      const s = nbytes / sec;
      this.speed.set(h, this.speed.has(h) ? this.speed.get(h) * 0.7 + s * 0.3 : s);
    }
  }

  fail(u, err) {
    const h = hostOf(u);
    const n = (this.fails.get(h) || 0) + 1;
    this.fails.set(h, n);
    if (this.speed.has(h))  // 失败也拉低速度估计，否则一个只是变慢的节点会一直排在前面；卡住超时的罚得更重
      this.speed.set(h, this.speed.get(h) * (/timed out/.test(String(err)) ? 0.25 : 0.5));
    if (n < HOST_FAIL_LIMIT || (this.cool.get(h) || 0) > this.now()) return;
    this.cool.set(h, this.now() + HOST_COOLDOWN);
    this.fails.set(h, 0);
    this.log(`节点 ${h} 连续失败 ${n} 次，降权 ${HOST_COOLDOWN} 秒：${err}`);
  }

  cooling() {
    const now = this.now();
    return [...this.cool].filter(([, t]) => t > now).map(([h]) => h);
  }
}

/** 一个流的候选节点：返回 [参与测速排序的链接, 最后才用的链接]。tmpl 是最近收到的原始链接，换域名得到快节点的链接。
 *  akamai 单个请求不慢，但总带宽只有约 1 MB/s、加并发也不涨，按单个请求的速度排序会被误判成快节点，所以只在第 3 次重试时用。 */
export function candidates(tmpl, urls) {
  const fast = tmpl ? FAST_HOSTS.map(h => onHost(tmpl, h)) : [];
  const akam = urls.filter(isAkamai);
  const main = [...new Set([...fast, ...urls.filter(u => !isAkamai(u))])];
  return main.length ? [main, akam] : [akam, []];
}

export const GOOD_RATIO = 0.3;  // 速度不低于最快节点 30% 的算「好节点」，预读只在它们之间分

/** 挑一个链接，返回 { url, explore }。explore 表示挑的是没测过的或慢的节点（试探），调用方据此限制试探的并发数。
 *  - urgent（播放器在等的块）：用测过的最快节点；一个都没测过时随机挑，让开头几个块分到不同节点上、顺便都测一遍。
 *  - 预读：在好节点之间按速度加权随机分（不全压在一个节点上，它卡住时不会把所有并发都堵住）；
 *    canExplore 时有 explore 的概率去试没测过的或慢的节点，让排名跟得上变化。
 *    按块数平均分是不行的：各节点速度能差上百倍（2026-10-29 实测 aliov 约 20 MB/s，08ct 0.1 MB/s），
 *    慢节点拉一块要十几秒，按时间算并发几乎全耗在慢节点上。
 *  - attempt：第几次重试，按排名依次换节点；第 3 次（attempt 2）用 akamai。 */
export function pick(health, [cands, backup], urgent, attempt, { avoid = null, canExplore = true, explore = 0.1, rnd = Math.random } = {}) {
  if (attempt === 2 && backup.length) return { url: backup[0], explore: true };
  let ranked = health.ranked(cands, false);
  if (avoid && ranked.length > 1) {
    const other = ranked.filter(u => hostOf(u) !== avoid);
    if (other.length) ranked = other;
  }
  const speed = u => health.speed.get(hostOf(u)) || 0;
  const best = speed(ranked[0]);
  const good = best > 0 ? ranked.filter(u => speed(u) >= best * GOOD_RATIO) : [];
  const rest = ranked.filter(u => !good.includes(u));
  const any = list => list[Math.floor(rnd() * list.length)];
  if (attempt) {
    const u = ranked[attempt % ranked.length];
    return { url: u, explore: !good.includes(u) };
  }
  if (!good.length) return { url: any(ranked), explore: true };
  if (!urgent && rest.length && canExplore && rnd() < explore) {
    const unknown = rest.filter(u => !health.speed.has(hostOf(u)));
    return { url: any(unknown.length ? unknown : rest), explore: true };
  }
  if (urgent) return { url: good[0], explore: false };
  let r = rnd() * good.reduce((sum, u) => sum + speed(u), 0);
  for (const u of good) if ((r -= speed(u)) <= 0) return { url: u, explore: false };
  return { url: good[0], explore: false };
}
