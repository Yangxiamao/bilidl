// 播放加速插件的缓存和调度（extension-play/src/engine.js）的离线测试：用假的 CDN 代替 fetch，不联网。
// 用法: node tests/play_engine_test.mjs
import assert from "node:assert/strict";
import { Engine, CHUNK } from "../extension-play/src/engine.js";
import { FAST_HOSTS, hostOf, HostHealth, pick } from "../shared/hosts.js";

const SIZE = 40 * CHUNK + 12345;  // 比最小预读窗口（32 MB）大，测得到窗口外的跳转
const PATH = "/upgcxcode/00/00/1/1-1-30120.m4s";
const FILE = Uint8Array.from({ length: SIZE }, (_, i) => (i * 31 + (i >> 9)) & 255);
const expect = (a, b) => FILE.subarray(a, b + 1);
const url = host => `https://${host}${PATH}?upsig=x&deadline=1`;
const ORIG = "upos-sz-mirrorcosov.bilivideo.com";
const AKAM = "upos-hz-mirrorakam.akamaized.net";

// 假 CDN：每个节点可以设成 ok / stall（发了响应头之后不再给数据）/ error（503）。记录每个 (节点, 起点) 的拉取次数
function cdn() {
  const mode = new Map(), log = [];
  async function fetch(u, init) {
    const host = hostOf(u), m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const a = +m[1], b = Math.min(+m[2], SIZE - 1);
    log.push({ host, a });
    await new Promise(r => setTimeout(r, 5));
    if (init.signal.aborted) throw init.signal.reason;
    if (mode.get(host) === "error") return new Response("x", { status: 503 });
    if (a >= SIZE) return new Response("", { status: 416 });
    const stall = mode.get(host) === "stall";
    let o = a;
    const body = new ReadableStream({
      async pull(c) {
        if (stall) return new Promise((_, bad) => init.signal.addEventListener("abort", () => bad(init.signal.reason)));
        await new Promise(r => setTimeout(r, 1));
        if (o > b) return c.close();
        const n = Math.min(256 << 10, b - o + 1);  // Windows 上 setTimeout(1) 实际约 15 毫秒，一次给多些，免得触发对冲
        c.enqueue(expect(o, o + n - 1));
        o += n;
      },
    });
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${a}-${b}/${SIZE}` } });
  }
  return { fetch, mode, log };
}

const timing = { fetchTimeout: 0.5, hedgeAfter: 0.15, urgentWait: 3, retryDelay: 0.05, janitor: 3600 };
const same = (buf, a, b) => assert.deepEqual(new Uint8Array(buf), expect(a, b), `bytes=${a}-${b} 数据不一致`);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("挑节点：预读按速度加权、不碰慢节点，紧急块用最快的，没测过时随机分", () => {
  const h = new HostHealth();
  const [A, B, C, D] = FAST_HOSTS.map(url);
  h.speed.set(hostOf(A), 20e6); h.speed.set(hostOf(B), 0.2e6); h.speed.set(hostOf(C), 6e6);  // D 没测过
  const n = { [A]: 0, [B]: 0, [C]: 0, [D]: 0 };
  for (let i = 0; i < 2000; i++) n[pick(h, [[A, B, C, D], []], false, 0, { canExplore: false }).url]++;
  assert.equal(n[B] + n[D], 0, "不能试探时不该挑慢节点或没测过的节点");
  assert.ok(n[A] > 1400 && n[C] > 300, JSON.stringify(n));  // 20 : 6
  let ex = 0;
  for (let i = 0; i < 2000; i++) { const r = pick(h, [[A, B, C, D], []], false, 0); if (r.explore) { ex++; assert.equal(r.url, D); } }
  assert.ok(ex > 100 && ex < 300, `试探 ${ex} 次`);  // 10%，先试没测过的
  assert.equal(pick(h, [[A, B, C, D], []], true, 0).url, A);
  assert.equal(pick(h, [[A, B, C, D], []], true, 0, { avoid: hostOf(A) }).url, C);
  const fresh = new Set(Array.from({ length: 200 }, () => pick(new HostHealth(), [[A, B, C, D], []], true, 0).url));
  assert.equal(fresh.size, 4);
});

test("各种 Range 和直连一致", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  for (const [a, b] of [[0, 999], [CHUNK - 10, CHUNK + 10], [5, 2 * CHUNK + 100], [SIZE - 1000, SIZE - 1],
                        [SIZE - 10, SIZE + 5000], [3 * CHUNK, 4 * CHUNK - 1]]) {
    const r = await e.request(url(ORIG), a, b);
    same(r.data, a, Math.min(b, SIZE - 1));
    assert.equal(r.size, SIZE);
  }
  await assert.rejects(e.request(url(ORIG), SIZE, SIZE + 10), /超出文件范围/);
  e.close();
});

test("8 个请求落在同一个没拉过的块上：块只拉一次", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => e.request(url(ORIG), 7 * CHUNK + i * 100, 7 * CHUNK + i * 100 + 5000)));
  rs.forEach((r, i) => same(r.data, 7 * CHUNK + i * 100, 7 * CHUNK + i * 100 + 5000));
  assert.equal(c.log.filter(x => x.a === 7 * CHUNK).length, 1);
  e.close();
});

test("只给 akamai 链接时换到 upos 节点拉，akamai 只在第 3 次重试时用", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  same((await e.request(url(AKAM), 0, 5000)).data, 0, 5000);
  assert.ok(c.log.every(x => FAST_HOSTS.includes(x.host)), JSON.stringify(c.log.map(x => x.host)));
  for (const h of FAST_HOSTS) c.mode.set(h, "error");
  same((await e.request(url(AKAM), 2 * CHUNK, 2 * CHUNK + 10)).data, 2 * CHUNK, 2 * CHUNK + 10);
  assert.ok(c.log.some(x => x.host === AKAM));
  e.close();
});

test("最快的节点卡住时 hedgeAfter 秒后对冲到别的节点", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  const slow = FAST_HOSTS[0];
  for (const h of FAST_HOSTS) e.health.speed.set(h, h === slow ? 1e9 : 1e6);
  c.mode.set(slow, "stall");
  const t0 = performance.now();
  same((await e.request(url(ORIG), 0, 1000)).data, 0, 1000);
  const dt = (performance.now() - t0) / 1000;
  assert.ok(dt < timing.fetchTimeout, `用了 ${dt.toFixed(2)} 秒，对冲没起作用`);
  assert.equal(e.stats().resources[0].hedges, 1);
  e.close();
});

test("所有节点都出错：抛异常（由 hook 退回直连）", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  for (const h of [...FAST_HOSTS, ORIG]) c.mode.set(h, "error");
  await assert.rejects(e.request(url(ORIG), 0, 1000), /HTTP 503/);
  e.close();
});

test("播放器取消请求时立刻返回", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  for (const h of [...FAST_HOSTS, ORIG]) c.mode.set(h, "stall");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const t0 = performance.now();
  await assert.rejects(e.request(url(ORIG), 0, 1000, ctl.signal), /已取消/);
  assert.ok(performance.now() - t0 < 300);
  e.close();
});

test("顺序播放时预读，跳出窗口算跳转并作废旧预读，回头要已缓存的不算跳转", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  for (let i = 0; i < 4; i++) await e.request(url(ORIG), i * 200000, i * 200000 + 199999);
  await new Promise(r => setTimeout(r, 1500));
  let st = e.stats().resources[0];
  assert.ok(st.chunks >= 30, `只预读了 ${st.chunks} 块`);  // 最小窗口 32 MB
  assert.equal(st.seeks, 0);
  await e.request(url(ORIG), 0, 1000);  // 回头要已缓存的数据
  assert.equal(e.stats().resources[0].seeks, 0);
  await e.request(url(ORIG), 39 * CHUNK, 39 * CHUNK + 1000);  // 窗口外
  st = e.stats().resources[0];
  assert.equal(st.seeks, 1);
  same((await e.request(url(ORIG), 39 * CHUNK + 1001, 40 * CHUNK + 50)).data, 39 * CHUNK + 1001, 40 * CHUNK + 50);
  e.close();
});

test("超过内存上限时丢掉播放位置之前的块", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  e.P = { ...e.P, mem: 8 * CHUNK, workers: 2, urgent: 1 };
  for (let i = 0; i < 20; i++) await e.request(url(ORIG), i * CHUNK, (i + 1) * CHUNK - 1);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(e.mem <= 12 * CHUNK, `内存 ${e.mem / CHUNK} MB`);
  // 不限内存时预读窗口（32 MB）会一直拉到文件末尾；限了以后最多领先 8 MB 再加上在飞的块
  const top = Math.max(...c.log.map(x => x.a / CHUNK));
  assert.ok(top <= 20 + 8 + 3, `内存超限后还在预读，拉到了第 ${top} 块`);
  e.close();
});

test("关闭加速时释放全部缓存", async () => {
  const c = cdn(), e = new Engine({ fetch: c.fetch, timing });
  await e.request(url(ORIG), 0, 3 * CHUNK);
  assert.ok(e.mem > 0);
  e.clear();
  assert.equal(e.mem, 0);
  assert.equal(e.stats().resources.length, 0);
  e.close();
});

let fail = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("通过", name);
  } catch (err) {
    fail++;
    console.log("失败", name, "\n ", err.message);
  }
}
console.log(fail ? `${fail} 项失败` : "全部通过");
process.exit(fail ? 1 : 0);
