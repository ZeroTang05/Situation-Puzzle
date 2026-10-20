/**
 * 把 SVG 图标栅格化成 PNG。
 *
 *   node scripts/icon-render.mjs [--icon apps/web/public/icon.svg] [--out <目录>] [--size 1024] [--name icon]
 *
 * 默认渲染 apps/web/public/icon.svg 到 apps/web/public/，
 * 产物 icon.png（1024×1024）——网页端目前只有 SVG，PNG 版供上传头像/封面等场景用。
 * 走 Playwright 真实渲染，SVG 原样保留，不重新设计。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './playwright-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const iconRel = argValue('--icon', 'apps/web/public/icon.svg');
const outDir = path.resolve(ROOT, argValue('--out', path.dirname(iconRel)));
const size = Number(argValue('--size', 1024));
const name = argValue('--name', 'icon');
const iconPath = path.resolve(ROOT, iconRel);

if (!fs.existsSync(iconPath)) throw new Error(`找不到图标源文件：${iconPath}`);
const svg = fs.readFileSync(iconPath, 'utf8');

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  #box{width:${size}px;height:${size}px}
  #box svg{width:100%;height:100%;display:block}
</style></head>
<body><div id="box">${svg}</div></body></html>`;

const browser = await launchBrowser();
let outPath;
try {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  const box = await page.locator('#box').boundingBox();
  outPath = path.join(outDir, `${name}.png`);
  // omitBackground：SVG 圆角外的部分导出为透明，方便裁圆形头像时露边
  await page.screenshot({
    path: outPath,
    clip: { x: box.x, y: box.y, width: size, height: size },
    omitBackground: true,
  });
  await page.close();
} finally {
  await browser.close();
}

process.stdout.write(
  `${JSON.stringify({ ok: true, src: iconRel, out: path.relative(ROOT, outPath), size: `${size}x${size}`, bytes: fs.statSync(outPath).size }, null, 2)}\n`,
);
