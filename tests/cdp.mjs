// 测试共用的 Chrome DevTools Protocol 客户端：用 --remote-debugging-pipe 启动 Chrome（stdio 第 3、4 个 fd 是管道），
// fd 3 写命令，fd 4 读结果，消息以 \0 分隔。dl_ext_test.mjs 和 dl_seek_test.mjs 用。

export class CDP {
  constructor(child) {
    this.w = child.stdio[3];
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    let buf = "";
    child.stdio[4].on("data", d => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.id && this.pending.has(m.id)) {
          const { ok, bad, method } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? bad(new Error(`${method}: ${m.error.message}`)) : ok(m.result);
        } else this.handlers.forEach(h => h(m));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.w.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    return new Promise((ok, bad) => this.pending.set(id, { ok, bad, method }));
  }
  on(h) { this.handlers.push(h); }
}

export async function evaluate(cdp, sid, expr, timeout = 600000) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
