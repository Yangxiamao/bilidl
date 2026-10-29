// 打包播放加速插件：把 shared/ 的公共代码和 extension-play/src/ 合成一个 page.js（包在一个函数里，不往页面上挂全局变量），
// 和其余文件一起放到 dist/extension-play/，在 chrome://extensions 里「加载已解压的扩展程序」选这个目录。
// 用法: node tools/build_ext.mjs [--zip]   --zip 时另外打一个上架 Chrome Web Store 用的 dist/extension-play-<版本>.zip
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, "extension-play");
const OUT = path.join(ROOT, "dist", "extension-play");
// page.js 的组成，按依赖顺序（每个文件里的 import 去掉、export 关键字去掉，合进同一个作用域）
const PAGE = ["shared/hosts.js", "extension-play/src/engine.js", "extension-play/src/hook.js"];
const COPY = ["manifest.json", "bridge.js", "background.js", "popup.html", "icons"];

function strip(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  return `// ---- ${file} ----\n` + src
    .replace(/^import [^;]+;\s*$/gm, "")
    .replace(/^export (?=(const|let|function|class|async) )/gm, "");
}

export async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const page = `// 由 tools/build_ext.mjs 生成，不要直接修改\n(() => {\n"use strict";\n${PAGE.map(strip).join("\n")}\ninstall(window);\n})();\n`;
  new vm.Script(page, { filename: "page.js" });  // 各文件合进同一个作用域，顶层重名等语法错误在这里就报出来
  fs.writeFileSync(path.join(OUT, "page.js"), page);
  for (const f of COPY) fs.cpSync(path.join(SRC, f), path.join(OUT, f), { recursive: true });
  const { PROFILES } = await import(pathToFileURL(path.join(SRC, "src", "engine.js")).href);
  const popup = fs.readFileSync(path.join(SRC, "popup.js"), "utf8");
  if (!popup.includes("/*PROFILES*/null")) throw new Error("popup.js 里找不到 /*PROFILES*/null");
  fs.writeFileSync(path.join(OUT, "popup.js"), popup.replace("/*PROFILES*/null", JSON.stringify(PROFILES)));
  return OUT;
}

async function main() {
  await build();
  const { version } = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  console.log("已生成", OUT, "版本", version);
  if (process.argv.includes("--zip")) {
    const zip = path.join(ROOT, "dist", `extension-play-${version}.zip`);
    fs.rmSync(zip, { force: true });
    // Windows 10+ 和 macOS 自带的 bsdtar 能打 zip；Windows 上 PATH 里可能先是 Git 带的 GNU tar（不会打 zip），所以写全路径
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-a", "-cf", path.relative(OUT, zip), "."], { cwd: OUT });
    console.log("已打包", zip);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
