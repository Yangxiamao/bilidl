// 打包纯插件下载器（extension-dl/ → dist/extension-dl/），在 chrome://extensions 里「加载已解压的扩展程序」选这个目录。
// 扩展页面和 Worker 都能直接用 ES 模块，原样复制；shared/ 复制到 dist/extension-dl/shared/，src/ 里的 import "../../shared/…" 改成 "../shared/…"。
// （播放加速插件已拆到 Yangxiamao/bilifast，有自己的打包脚本。）
// 用法: node tools/build_ext.mjs [--zip]   --zip 时另外打上架 Chrome Web Store 用的 dist/extension-dl-<版本>.zip
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DL_SRC = path.join(ROOT, "extension-dl");
const DL_OUT = path.join(ROOT, "dist", "extension-dl");
const DL_COPY = ["manifest.json", "background.js", "offscreen.html", "offscreen.js", "popup.html", "popup.js", "icons"];

/** 打包下载插件，返回输出目录。 */
export function buildDl() {
  fs.rmSync(DL_OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(DL_OUT, "src"), { recursive: true });
  for (const f of DL_COPY) fs.cpSync(path.join(DL_SRC, f), path.join(DL_OUT, f), { recursive: true });
  for (const f of fs.readdirSync(path.join(DL_SRC, "src"))) {
    const src = fs.readFileSync(path.join(DL_SRC, "src", f), "utf8");
    fs.writeFileSync(path.join(DL_OUT, "src", f), src.replace(/(from\s+["'])\.\.\/\.\.\/shared\//g, "$1../shared/"));
  }
  fs.cpSync(path.join(ROOT, "shared"), path.join(DL_OUT, "shared"), { recursive: true });
  return DL_OUT;
}

function zip(out, name) {
  const { version } = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  const file = path.join(ROOT, "dist", `${name}-${version}.zip`);
  fs.rmSync(file, { force: true });
  // Windows 10+ 和 macOS 自带的 bsdtar 能打 zip；Windows 上 PATH 里可能先是 Git 带的 GNU tar（不会打 zip），所以写全路径
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-a", "-cf", path.relative(out, file), "."], { cwd: out });
  console.log("已打包", file);
}

function main() {
  buildDl();
  console.log("已生成", DL_OUT, "版本", JSON.parse(fs.readFileSync(path.join(DL_SRC, "manifest.json"), "utf8")).version);
  if (process.argv.includes("--zip")) zip(DL_OUT, "extension-dl");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
