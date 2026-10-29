// MD5（WBI 签名要用，WebCrypto 不提供 MD5）。输入按 UTF-8 编码，返回 32 位小写十六进制。
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(str) {
  const msg = new TextEncoder().encode(str);
  const n = ((msg.length + 8) >> 6) + 1;
  const words = new Uint32Array(n * 16);
  for (let i = 0; i < msg.length; i++) words[i >> 2] |= msg[i] << (i % 4 * 8);
  words[msg.length >> 2] |= 0x80 << (msg.length % 4 * 8);
  words[n * 16 - 2] = msg.length * 8;  // WBI 的输入很短，长度的高 32 位总是 0
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < n * 16; blk += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const s = S[(i >> 4) * 4 + i % 4];
      const x = (a + f + K[i] + words[blk + g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(v => [0, 8, 16, 24].map(sh => ((v >>> sh) & 255).toString(16).padStart(2, "0")).join("")).join("");
}
