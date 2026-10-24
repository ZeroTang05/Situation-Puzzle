/**
 * 从品牌图标 apps/web/public/icon.svg 生成 Android 启动器图标全密度 PNG。
 *
 *   node scripts/app-icons.mjs
 *
 * 产物（写入 apps/app/android/app/src/main/res/）：
 *   mipmap-{mdpi..xxxhdpi}/ic_launcher.png            方形（圆角外透明）
 *   mipmap-{mdpi..xxxhdpi}/ic_launcher_round.png      圆形背景
 *   mipmap-{mdpi..xxxhdpi}/ic_launcher_foreground.png 自适应前景层（图案居中安全区）
 *
 * 栅格化走 Playwright 真实渲染（同 icon-render.mjs），不引入新依赖；
 * 图标源只有一个（icon.svg），改品牌图案后重跑本脚本即可全量再生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './playwright-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON = path.join(ROOT, 'apps/web/public/icon.svg');
const RES = path.join(ROOT, 'apps/app/android/app/src/main/res');

// 密度 → 像素：旧版启动器图标 48dp 基准、自适应前景层 108dp 画布
const LAUNCHER_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

// 自适应前景层的图案摆位：icon.svg 的图案（汤碗+热气）约占 42×51（64 网格），
// 缩到 1.15 并平移居中，让最远笔画落在 108 画布中间 66dp 安全区内（启动器会
// 裁成圆形/圆角，出安全区的部分会被切掉）。改图案后如果形状变长，需要重算。
const FG_TRANSFORM = 'translate(17.2 16.7) scale(1.15)';

const svg = fs.readFileSync(ICON, 'utf8');

// 去掉背景圆角矩形，剩下的就是纯图案（汤碗 + 热气 + 圆点）
const BG_RECT = /<rect width="64" height="64" rx="15" fill="#0a1522"\/>/.source;
const bgRect = new RegExp(BG_RECT);
if (!bgRect.test(svg)) {
  throw new Error('icon.svg 里找不到背景矩形——品牌图结构变了，请同步更新本脚本的拆分规则');
}
const marks = svg.replace(bgRect, '')
  .replace(/<\/?svg[^>]*>/g, '') // 只留中间图案元素，viewBox 由各变体自己定
  .trim();

/** 三个变体的完整 SVG：方形（原样）、圆形（圆底）、前景（透明底图案居中） */
function squareSvg() {
  return svg;
}
function roundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="32" fill="#0a1522"/>
  ${marks}
</svg>`;
}
function foregroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <g transform="${FG_TRANSFORM}">${marks}</g>
</svg>`;
}

/** 把一个 SVG 字符串在指定像素尺寸下截图成透明 PNG */
async function renderPng(page, svgText, size, outPath) {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  #box{width:${size}px;height:${size}px}
  #box svg{width:100%;height:100%;display:block}
</style></head>
<body><div id="box">${svgText}</div></body></html>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html, { waitUntil: 'load' });
  // omitBackground：SVG 圆角/圆形外的部分保持透明
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
  return fs.statSync(outPath).size;
}

const jobs = [];
for (const [density, size] of Object.entries(LAUNCHER_SIZES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  jobs.push([squareSvg(), size, path.join(dir, 'ic_launcher.png')]);
  jobs.push([roundSvg(), size, path.join(dir, 'ic_launcher_round.png')]);
}
for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
  jobs.push([foregroundSvg(), size, path.join(RES, `mipmap-${density}`, 'ic_launcher_foreground.png')]);
}

const browser = await launchBrowser();
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 108, height: 108 }, deviceScaleFactor: 1 });
  for (const [svgText, size, outPath] of jobs) {
    const bytes = await renderPng(page, svgText, size, outPath);
    results.push({ out: path.relative(ROOT, outPath), size: `${size}x${size}`, bytes });
  }
  await page.close();
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, count: results.length, results }, null, 2)}\n`);
