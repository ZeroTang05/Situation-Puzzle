#!/usr/bin/env node
/**
 * 小红书日更 · 卡片渲染
 *
 * 统一的无文字背景图（系列识别）+ 真实排版的中文。
 * 单张卡片的「标题 + 正文」不超过 100 字，超出的部分自动拆成多张卡片，
 * 全系列共用同一张背景图，保证连载号的视觉一致性。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './playwright-runtime.mjs';

const CJK_FONTS = '"Microsoft YaHei","微软雅黑","Noto Sans SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB",sans-serif';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------------ 分卡 */

/**
 * 规划一段内容要占几张卡片。
 * 卡片数 = ceil(正文长度 / maxChars)，正文在卡片之间尽量均分（差 ≤1 字），
 * 因此不会出现"只有十几个字"的碎尾；切点优先落在句读上。
 * 标题、页脚、日序号、页码属于固定版式装饰，不占正文预算。
 * @returns {{ cards: Array<{ title: string, text: string, isFirst: boolean }> }}
 */
function planSectionCards({ title, text, maxChars }) {
  const src = String(text ?? '').trim();
  if (!src) return { cards: [] };
  const total = src.length;
  const count = Math.max(1, Math.ceil(total / maxChars));
  const per = Math.floor(total / count);
  const rem = total % count;

  const cards = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const size = per + (i < rem ? 1 : 0);
    const target = pos + size;
    let cut;
    if (i === count - 1) {
      cut = src.length; // 最后一张拿走全部剩余
    } else {
      // 下界：保证剩下的卡片都还能塞进 maxChars
      const lo = Math.max(pos + 1, total - maxChars * (count - i - 1), Math.floor(target * 0.78));
      cut = target;
      for (let p = target; p > lo; p--) {
        if ('。！？；\n，、：'.includes(src[p - 1])) {
          cut = p;
          break;
        }
      }
    }
    cards.push({ title: i === 0 ? (title ?? '') : '', text: src.slice(pos, cut).trim(), isFirst: i === 0 });
    pos = cut;
  }
  return { cards };
}

/* ------------------------------------------------------------------ 渲染 */

/** 纯代码生成的背景层：渐变 + 程序化噪点 + 雾 + 暗角，不依赖任何图片文件 */
const CSS_VARIANTS = {
  cool: `
  .bgcss { position:absolute; inset:0; pointer-events:none;
    background-color:#05060a;
    background-image:
      radial-gradient(ellipse 70% 16% at 50% 8%, rgba(175,200,232,.22), transparent 72%),
      radial-gradient(ellipse 8% 5% at 50% 11%, rgba(255,235,205,.50), transparent 74%),
      conic-gradient(from 150deg at 50% 11%, rgba(0,0,0,0) 0deg, rgba(255,226,185,.16) 6deg, rgba(0,0,0,0) 13deg, rgba(255,226,185,.11) 18deg, rgba(0,0,0,0) 26deg),
      radial-gradient(ellipse 72% 16% at 50% 100%, rgba(130,162,196,.20), transparent 72%),
      repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 2px, rgba(255,255,255,0) 2px 9px),
      linear-gradient(180deg, rgba(0,0,0,.30) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 58%, rgba(0,0,0,.35) 100%),
      linear-gradient(180deg, #121722 0%, #0a0e17 44%, #05070c 100%);
  }`,
  warm: `
  .bgcss { position:absolute; inset:0; pointer-events:none;
    background-color:#0a0606;
    background-image:
      radial-gradient(ellipse 72% 18% at 50% 10%, rgba(226,132,96,.26), transparent 72%),
      radial-gradient(ellipse 9% 6% at 50% 13%, rgba(255,206,150,.55), transparent 74%),
      conic-gradient(from 150deg at 50% 13%, rgba(0,0,0,0) 0deg, rgba(255,170,110,.18) 6deg, rgba(0,0,0,0) 13deg, rgba(255,170,110,.12) 18deg, rgba(0,0,0,0) 26deg),
      radial-gradient(ellipse 74% 16% at 50% 100%, rgba(190,90,70,.22), transparent 72%),
      repeating-linear-gradient(90deg, rgba(255,220,200,.05) 0 2px, rgba(255,255,255,0) 2px 9px),
      linear-gradient(180deg, rgba(0,0,0,.30) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 58%, rgba(0,0,0,.35) 100%),
      linear-gradient(180deg, #1a0f0c 0%, #120a09 44%, #060404 100%);
  }`,
};

export function cssBackground(variant = 'cool') {
  return CSS_VARIANTS[variant] ?? CSS_VARIANTS.cool;
}

const GRAIN_CSS = `
  .grain { position:absolute; inset:0; opacity:.38; mix-blend-mode:overlay; pointer-events:none;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='240' height='240' filter='url(%23n)' opacity='0.5'/></svg>");
    background-size:240px 240px; }
  .vignette { position:absolute; inset:0; pointer-events:none;
    background:radial-gradient(ellipse 92% 72% at 50% 40%, rgba(0,0,0,0) 46%, rgba(0,0,0,.55) 100%); }
`;

function buildCardHtml({ backgroundPath, backgroundMode, cssVariant, label, badge, title, subtitle, text, page, footer, width, height, accent }) {
  const useCss = backgroundMode === 'css';
  const bg = useCss ? '' : pathToFileURL(backgroundPath).href;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:${width}px; height:${height}px; background:#05060a; }
body { position:relative; overflow:hidden; font-family:${CJK_FONTS}; color:#fff; -webkit-font-smoothing:antialiased; }
${useCss ? cssBackground(cssVariant) + GRAIN_CSS : ''}
.bg { position:absolute; left:0; top:0; width:100%; height:100%; object-fit:cover; }
.veil { position:absolute; inset:0; background:${useCss ? 'linear-gradient(180deg, rgba(4,5,10,.30) 0%, rgba(4,5,10,.42) 30%, rgba(4,5,10,.58) 60%, rgba(4,5,10,.78) 100%)' : 'linear-gradient(180deg, rgba(4,5,10,.62) 0%, rgba(4,5,10,.5) 26%, rgba(4,5,10,.72) 52%, rgba(4,5,10,.9) 100%)'}; }
.frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,.12); }
.topbar { position:absolute; top:58px; left:76px; right:76px; display:flex; justify-content:space-between; align-items:center; font-size:28px; letter-spacing:3px; color:rgba(255,255,255,.72); text-shadow:0 2px 10px rgba(0,0,0,.9); }
.badge { border:1px solid ${accent}80; color:${accent}; padding:5px 18px; letter-spacing:5px; font-size:26px; }
.stage { position:absolute; left:72px; right:72px; top:170px; bottom:150px; display:flex; flex-direction:column; justify-content:center; }
.ctitle { font-size:54px; font-weight:700; color:${accent}; letter-spacing:2px; line-height:1.3; margin-bottom:30px; text-shadow:0 3px 20px rgba(0,0,0,.9); }
.csub { font-size:36px; color:rgba(255,255,255,.72); letter-spacing:2px; margin-bottom:26px; text-shadow:0 3px 16px rgba(0,0,0,.9); }
.ctext { font-size:70px; line-height:1.58; color:rgba(255,255,255,.96); letter-spacing:1px; text-shadow:0 3px 18px rgba(0,0,0,.92); overflow-wrap:anywhere; }
.bottom { position:absolute; left:76px; right:76px; bottom:66px; display:flex; justify-content:space-between; align-items:flex-end; font-size:29px; color:${accent}; letter-spacing:1px; text-shadow:0 2px 10px rgba(0,0,0,.9); }
.page { color:rgba(255,255,255,.55); }
</style></head>
<body>
${useCss ? '<div class="bgcss"></div><div class="grain"></div><div class="vignette"></div>' : `<img class="bg" src="${escapeHtml(bg)}" alt="" />`}
<div class="veil"></div>
<div class="frame"></div>
<div class="topbar"><span>${escapeHtml(label)}</span><span class="badge">${escapeHtml(badge)}</span></div>
<div class="stage">
  ${title ? `<div class="ctitle">《${escapeHtml(title)}》</div>` : ''}
  ${subtitle ? `<div class="csub">《${escapeHtml(subtitle)}》</div>` : ''}
  <div class="ctext" id="ctext">${escapeHtml(text)}</div>
</div>
<div class="bottom">
  <span>${escapeHtml(footer ?? '')}</span>
  <span class="page">${escapeHtml(page)}</span>
</div>
</body></html>`;
}

async function renderCard(browser, { backgroundPath, backgroundMode, cssVariant, outPath, htmlPath, ...opts }) {
  const html = buildCardHtml({ backgroundPath, backgroundMode, cssVariant, ...opts });
  fs.writeFileSync(htmlPath, html, 'utf8');
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  if (backgroundMode !== 'css') {
    await page.waitForFunction(() => {
      const img = document.querySelector('img.bg');
      return !!img && img.complete && img.naturalWidth > 0;
    });
  }
  const fit = await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const text = document.querySelector('#ctext');
    let size = 70;
    text.style.fontSize = `${size}px`;
    while (size > 32 && text.getBoundingClientRect().height > stage.clientHeight) {
      size -= 2;
      text.style.fontSize = `${size}px`;
    }
    return { size, overflow: text.getBoundingClientRect().height > stage.clientHeight };
  });
  await page.screenshot({ path: outPath });
  await page.close();
  return { outPath, fontSize: fit.size, overflow: fit.overflow };
}

/**
 * 渲染一整期笔记的全部卡片。
 * @param sections [{ kind, label, badge, title, text, footer }]
 * @returns {Promise<{ pages: Array<{ outPath, kind, page, chars, totalChars, fontSize, overflow }> }>}
 */
export async function renderCards({
  backgroundMode = 'image',
  outDir,
  sections,
  maxChars = 130,
  maxTotalCards = 18,
  width = 1080,
  height = 1440,
  accent = '#e3b273',
}) {
  const browser = await launchBrowser();
  const htmlPath = path.join(outDir, '.card.html');
  let pages = [];
  let relaxed = false;
  try {
    const buildPlan = (limit) => sections.map((s) => planSectionCards({ title: s.title, text: s.text, maxChars: limit }));

    let limit = maxChars;
    let plan = buildPlan(limit);
    let total = plan.reduce((n, p) => n + p.cards.length, 0);
    // 小红书单篇最多 18 张：极端长题放宽每张字数上限，保证张数不超限
    while (total > maxTotalCards && limit < 240) {
      limit = Math.ceil(limit * 1.1);
      plan = buildPlan(limit);
      total = plan.reduce((n, p) => n + p.cards.length, 0);
      relaxed = true;
    }

    let global = 0;
    const planned = [];
    sections.forEach((s, si) => {
      const cards = plan[si].cards;
      cards.forEach((card, i) => {
        global += 1;
        const isLast = i === cards.length - 1;
        const outPath = path.join(
          outDir,
          `${String(global).padStart(2, '0')}-${s.kind === 'face' ? '汤面' : '汤底'}.png`,
        );
        planned.push({ section: s, card, isLast, outPath, page: `${global}/${total}` });
      });
    });

    // 真正渲染
    const rendered = [];
    for (const p of planned) {
      const s = p.section;
      const r = await renderCard(browser, {
        backgroundPath: s.background,
        backgroundMode,
        cssVariant: s.cssVariant,
        outPath: p.outPath,
        htmlPath,
        label: s.label,
        badge: s.badge,
        title: p.card.title ?? '',
        subtitle: p.card.isFirst ? '' : (s.title ?? ''),
        text: p.card.text,
        page: p.page,
        footer: p.isLast ? (s.footer ?? '') : '',
        width,
        height,
        accent,
      });
      rendered.push({
        outPath: p.outPath,
        kind: p.section.kind,
        page: p.page,
        chars: p.card.text.length,
        totalChars: (s.title ? s.title.length + 2 : 0) + p.card.text.length,
        fontSize: r.fontSize,
        overflow: r.overflow,
      });
    }
    pages = rendered;
  } finally {
    await browser.close();
    try {
      fs.unlinkSync(htmlPath);
    } catch {
      /* 忽略 */
    }
  }
  return { pages, relaxed };
}

/** 把大图压成目标尺寸的 JPEG（用于统一背景图入库） */
export async function makeCoverJpeg({ srcPath, outPath, width, height, quality = 88 }) {
  const browser = await launchBrowser();
  const htmlPath = `${outPath}.html`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box} html,body{width:${width}px;height:${height}px;background:#05060a;overflow:hidden}
      img{width:100%;height:100%;object-fit:cover;display:block}
    </style></head><body><img src="${escapeHtml(pathToFileURL(srcPath).href)}" /></body></html>`;
    fs.writeFileSync(htmlPath, html, 'utf8');
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const img = document.querySelector('img');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: 'jpeg', quality });
    await page.close();
  } finally {
    await browser.close();
    try {
      fs.unlinkSync(htmlPath);
    } catch {
      /* 忽略 */
    }
  }
  return outPath;
}
