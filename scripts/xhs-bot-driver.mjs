/**
 * 小红书评论区机器人 · 浏览器驱动
 *
 * 用持久化用户目录（data/xhs/bot/browser-profile）保存登录态：扫码一次即可长期复用。
 * 小红书网页版改版频繁，所以所有选择器都走"候选列表 + 结构兜底"，
 * 并且提供 probe 命令把评论区结构 dump 出来，改选择器时不用瞎猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './playwright-runtime.mjs';

const XHS_HOME = 'https://www.xiaohongshu.com';
const NOTE_ID_RE = /([0-9a-f]{24})/;

/** 从笔记链接里抠出 noteId */
export function extractNoteId(input) {
  const m = NOTE_ID_RE.exec(String(input ?? ''));
  return m ? m[1] : null;
}

/** 启动持久化上下文（保留登录态） */
export async function openContext({ profileDir, headless = false, slowMo = 0 }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const pw = (await import('./playwright-runtime.mjs')).resolvePlaywright();
  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless,
    slowMo,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  context.setDefaultTimeout(30_000);
  return context;
}

/** 登录：打开首页，等用户扫码 */
export async function loginInteractive({ profileDir, timeoutMs = 5 * 60 * 1000 }) {
  const context = await openContext({ profileDir, headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${XHS_HOME}/explore`, { waitUntil: 'domcontentloaded' });

  const loggedIn = await page
    .waitForFunction(
      () => {
        const cookie = document.cookie.includes('web_session') || localStorage.getItem('web_session');
        const user = document.querySelector('.user .link-wrapper, .main-container .user, [class*="user-info"]');
        return Boolean(cookie || user);
      },
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);

  await context.close();
  return { loggedIn };
}

/** 打开笔记页并滚到底，把评论区尽量加载出来 */
export async function openNote(page, noteId, { scrollRounds = 6 } = {}) {
  const url = `${XHS_HOME}/explore/${noteId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  let last = -1;
  for (let i = 0; i < scrollRounds; i++) {
    const count = await page.evaluate(() => {
      const items = document.querySelectorAll(
        '.comment-item, [class*="comment-item"], .comments-container [class*="comment"]',
      );
      return items.length;
    });
    await page.evaluate(() => {
      // 网页版的评论区常在独立滚动容器里，两个都滚
      const containers = [
        document.querySelector('.note-scroller'),
        document.querySelector('.comment-list'),
        document.querySelector('.comments-container'),
        document.scrollingElement,
      ].filter(Boolean);
      for (const c of containers) {
        c.scrollTop = c.scrollHeight;
        c.scrollBy?.(0, 2000);
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1200);
    if (count === last) break;
    last = count;
  }
  return url;
}

/** 抽取评论（页面内执行，兼容多套选择器） */
export async function readComments(page) {
  return page.evaluate(() => {
    const pickText = (root, sels) => {
      for (const s of sels) {
        const el = root.querySelector(s);
        const t = el?.textContent?.trim();
        if (t) return t;
      }
      return '';
    };
    const itemSelectors = [
      '.comment-item',
      '[class*="comment-item"]',
      '.comments-container [class*="comment"]',
      '.note-scroller [class*="comment"]',
    ];
    let items = [];
    for (const sel of itemSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > items.length) items = found;
    }
    // 结构兜底：找不到标准结构时，用「含日期短文本的兄弟块」凑
    if (!items.length) {
      const dates = Array.from(document.querySelectorAll('[class*="date"], .date, time'));
      items = dates.map((d) => d.closest('div')).filter((d) => d && d.querySelector('[class*="content"], .content'));
    }
    const out = [];
    const seen = new Set();
    items.forEach((el, idx) => {
      const author = pickText(el, ['.author .name', '.author', '.name', '[class*="author"] [class*="name"]']);
      const content = pickText(el, ['.content', '.note-text', '[class*="content"]']);
      const time = pickText(el, ['.date', '.date-wrapper .date', '[class*="date"]']);
      if (!content) return;
      const key = `${author}|${content}|${time}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        id: el.getAttribute('data-id') || el.getAttribute('data-comment-id') || el.id || `idx-${idx}`,
        author,
        content,
        time,
        index: idx,
      });
    });
    return out;
  });
}

/** 在某条评论下回复 */
export async function replyToComment(page, comment, text) {
  const items = page.locator('.comment-item, [class*="comment-item"]');
  const count = await items.count();
  let target = null;
  for (let i = 0; i < count; i++) {
    const el = items.nth(i);
    const c = await el.innerText().catch(() => '');
    if (c.includes(comment.content.slice(0, 12))) {
      target = el;
      break;
    }
  }
  if (!target) throw new Error(`找不到要回复的评论：${comment.content.slice(0, 20)}`);

  // 点「回复」：优先评论内的回复按钮，其次长按式菜单
  const replyBtn = target.locator('text=回复').first();
  if (await replyBtn.count()) {
    await replyBtn.click({ timeout: 5000 }).catch(() => {});
  } else {
    const fallback = target.locator('[class*="reply"]').first();
    if (await fallback.count()) await fallback.click({ timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(600);

  // 输入框：评论区的 contenteditable
  const input = page
    .locator('.reply-container [contenteditable="true"], .comment-input [contenteditable="true"], [contenteditable="true"]')
    .last();
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await input.fill('');
  await input.type(text, { delay: 40 });
  await page.waitForTimeout(300);

  // 发送
  const send = page.locator('.submit .btn, .right-btn-area .btn, button:has-text("发送")').last();
  await send.click({ timeout: 10_000 });
  await page.waitForTimeout(1200);
}

/** 诊断：把评论区结构 dump 出来，方便改选择器 */
export async function probeNote(page, noteId, outDir) {
  await openNote(page, noteId, { scrollRounds: 4 });
  fs.mkdirSync(outDir, { recursive: true });
  const shot = path.join(outDir, 'note.png');
  await page.screenshot({ path: shot, fullPage: false });

  const info = await page.evaluate(() => {
    const containers = ['.comments-container', '.comment-list', '#note-container', '.note-scroller'];
    const found = [];
    for (const c of containers) {
      const el = document.querySelector(c);
      if (el) {
        found.push({
          selector: c,
          childCount: el.children.length,
          classNames: Array.from(new Set(Array.from(el.querySelectorAll('*')).map((e) => e.className).filter((x) => typeof x === 'string' && x))).slice(0, 60),
        });
      }
    }
    const all = Array.from(new Set(Array.from(document.querySelectorAll('div,span')).map((e) => e.className).filter((c) => typeof c === 'string' && /comment/i.test(c))));
    return {
      title: document.title,
      url: location.href,
      containers: found,
      commentishClasses: all.slice(0, 60),
      bodyTextSample: document.body.innerText.slice(0, 1500),
    };
  });
  const html = await page.evaluate(() => {
    const el = document.querySelector('.comments-container, .comment-list, #note-container') ?? document.body;
    return el.outerHTML.slice(0, 60_000);
  });
  fs.writeFileSync(path.join(outDir, 'comment-area.html'), html, 'utf8');
  fs.writeFileSync(path.join(outDir, 'structure.json'), JSON.stringify(info, null, 2), 'utf8');
  return { shot, ...info };
}
