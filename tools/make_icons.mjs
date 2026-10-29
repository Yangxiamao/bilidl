// 生成播放加速插件的图标和 Chrome 应用商店的图片：用无头 Chrome 的 --screenshot 把 extension-play/store/ 里的 SVG / HTML 渲染成图片。
//   extension-play/icons/16|32|48|128.png：16、32 用简化版 icon-16.svg；48 裁掉四周的透明边，在扩展管理页上显得大一些；
//                                       128 保留 16px 透明边（商店的要求）
//   extension-play/store/promo-440x280.jpg、screenshot-compare-1280x800.jpg：商店要求不带透明通道，所以用 jpg
// 用法: node tools/make_icons.mjs   （改了 store/ 里的源文件后重新运行，生成的图片一起提交）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE = path.join(ROOT, "extension-play", "store");
const ICONS = path.join(ROOT, "extension-play", "icons");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// [源文件, 输出, 宽, 高, SVG 改用的 viewBox（null 时不改）]
const JOBS = [
  ["icon-16.svg", path.join(ICONS, "16.png"), 16, 16, null],
  ["icon-16.svg", path.join(ICONS, "32.png"), 32, 32, null],
  ["icon.svg", path.join(ICONS, "48.png"), 48, 48, "12 12 104 104"],
  ["icon.svg", path.join(ICONS, "128.png"), 128, 128, null],
  ["promo.html", path.join(STORE, "promo-440x280.jpg"), 440, 280, null],
  ["compare.html", path.join(STORE, "screenshot-compare-1280x800.jpg"), 1280, 800, null],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bilidl-icons-"));
try {
  for (const [src, out, w, h, viewBox] of JOBS) {
    let page = path.join(STORE, src);
    if (src.endsWith(".svg")) {
      // 把 SVG 内联进一个页面，按目标尺寸直接矢量渲染，不从大图缩小
      let svg = fs.readFileSync(page, "utf8").replace(/ width="\d+" height="\d+"/, ` width="${w}" height="${h}"`);
      if (viewBox) svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`);
      page = path.join(tmp, "page.html");
      fs.writeFileSync(page, `<!doctype html><html><body style="margin:0">${svg.replace(/^<svg/m, '<svg style="display:block"')}</body></html>`);
    }
    // 透明背景只对 png 有意义；jpg 由页面自己的背景铺满
    execFileSync(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${path.join(tmp, "profile")}`,
      "--default-background-color=00000000", "--force-device-scale-factor=1", `--window-size=${w},${h}`,
      `--screenshot=${out}`, pathToFileURL(page).href], { stdio: "ignore" });
    console.log("已生成", path.relative(ROOT, out), `${w}x${h}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
