#!/usr/bin/env node
/**
 * 小红书评论区机器人
 *
 *   node scripts/xhs-bot.mjs login            # 扫码登录（一次即可，登录态存在 browser-profile）
 *   node scripts/xhs-bot.mjs discover          # 扫描个人主页，自动把新笔记绑定到题号
 *   node scripts/xhs-bot.mjs link <笔记链接> --day 1   # 手动绑定
 *   node scripts/xhs-bot.mjs probe <笔记链接>  # 诊断评论区结构（改选择器用）
 *   node scripts/xhs-bot.mjs once              # 跑一轮
 *   node scripts/xhs-bot.mjs run               # 常驻服务
 *   node scripts/xhs-bot.mjs status            # 看状态
 *
 * 处理链路：抓评论 → MiniMax 判是不是提问 → 提问则调自家判题接口 → 从话术池随机挑一句回复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './xhs-bot-store.mjs';
import {
  buildReply,
  buildPuzzleIdMap,
  classifyComment,
  createSession,
  judge,
  loadEnvFile,
  templatePoolSizes,
} from './xhs-bot-agent.mjs';
import { extractNoteId, loginInteractive, openContext, openNote, probeNote, readComments, replyToComment } from './xhs-bot-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'xhs', 'bot', 'config.json');

const DEFAULTS = {
  apiBase: 'http://localhost:8080/api/v1',
  pollIntervalSec: 120,
  replyDelaySec: [25, 70],
  maxRepliesPerDay: 40,
  maxRepliesPerNote: 15,
  headless: false,
  profileUrl: '',
  browserProfile: 'data/xhs/bot/browser-profile',
  stateFile: 'data/xhs/bot/state.json',
  notesFile: 'data/xhs/bot/notes.json',
  minimax: {
    apiKeyEnv: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.cn/anthropic',
    model: 'MiniMax-M2.7',
  },
  replyOnUncertain: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_PATH)) Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  return cfg;
}

function loadLibrary() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'library.json'), 'utf8'));
}

function log(...args) {
  process.stdout.write(`[xhs-bot ${new Date().toLocaleTimeString('zh-CN')}] ${args.join(' ')}\n`);
}

/* --------------------------------------------------------------- 工具 */

function puzzleForDay(library, day) {
  const entry = library[day - 1];
  if (!entry) throw new Error(`题号越界：第 ${day} 天（题库共 ${library.length} 题）`);
  return { day, legacyId: entry.id, title: entry.title, story: entry.story, answer: entry.answer, category: entry.category };
}

/** legacyId → 数据库 UUID（本地缓存 + 必要时拉一次全量题目表） */
async function resolvePuzzleId(store, config, legacyId) {
  const cached = store.getPuzzleId(legacyId);
  if (cached) return cached;
  log('拉取题库 UUID 映射…');
  const map = await buildPuzzleIdMap({ apiBase: config.apiBase });
  for (const [k, v] of map) store.setPuzzleId(k, v);
  store.save();
  const id = map.get(legacyId);
  if (!id) throw new Error(`题库里找不到 ${legacyId} 对应的 UUID（API 与题库不同步？）`);
  return id;
}

async function ensureToken(store, config, puzzleId) {
  const cached = store.getToken(puzzleId);
  if (cached) return cached;
  const token = await createSession({ apiBase: config.apiBase, puzzleId });
  store.setToken(puzzleId, token);
  store.save();
  return token;
}

function randomDelay(range) {
  const [min, max] = Array.isArray(range) ? range : [range, range];
  return (min + Math.random() * Math.max(0, max - min)) * 1000;
}

/* --------------------------------------------------------------- 命令 */

async function cmdLogin(config) {
  const profileDir = path.resolve(ROOT, config.browserProfile);
  log('打开浏览器，请用小红书 App 扫码登录…');
  const { loggedIn } = await loginInteractive({ profileDir });
  if (!loggedIn) {
    log('未检测到登录成功。登录态已保存在 ' + config.browserProfile + '，可再跑一次 login。');
    process.exitCode = 1;
    return;
  }
  log('登录成功，登录态已保存到 ' + config.browserProfile);
}

async function cmdProbe(config, noteArg) {
  const noteId = extractNoteId(noteArg);
  if (!noteId) throw new Error('没从链接里解析出 noteId');
  const profileDir = path.resolve(ROOT, config.browserProfile);
  const context = await openContext({ profileDir, headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const outDir = path.join(ROOT, 'data', 'xhs', 'bot', 'probe');
    const info = await probeNote(page, noteId, outDir);
    log('诊断输出目录：' + path.relative(ROOT, outDir));
    log('页面标题：' + info.title);
    log('候选容器：' + JSON.stringify(info.containers.map((c) => c.selector)));
  } finally {
    await context.close();
  }
}

async function cmdDiscover(config) {
  if (!config.profileUrl) throw new Error('请先在 data/xhs/bot/config.json 里填 profileUrl（个人主页链接）');
  const library = loadLibrary();
  const store = createStore({ root: ROOT, config });
  const profileDir = path.resolve(ROOT, config.browserProfile);
  const context = await openContext({ profileDir, headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
    }
    const found = await page.evaluate(() => {
      const out = [];
      const links = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]'));
      for (const a of links) {
        const m = /([0-9a-f]{24})/.exec(a.getAttribute('href') ?? '');
        if (!m) continue;
        const title =
          a.getAttribute('title') ||
          a.querySelector('[class*="title"]')?.textContent?.trim() ||
          a.textContent?.trim() ||
          '';
        out.push({ noteId: m[1], title });
      }
      return out;
    });
    let bound = 0;
    for (const item of found) {
      if (store.notes()[item.noteId]) continue;
      const hit = library.find((e) => item.title.includes(e.title) || item.title.includes(`《${e.title}》`));
      if (!hit) continue;
      const day = library.indexOf(hit) + 1;
      store.bindNote(item.noteId, { day, legacyId: hit.id, title: hit.title, url: `https://www.xiaohongshu.com/explore/${item.noteId}` });
      log(`绑定：${item.noteId} → 第 ${day} 天《${hit.title}》`);
      bound += 1;
    }
    store.save();
    log(`发现 ${found.length} 篇笔记，新绑定 ${bound} 篇`);
  } finally {
    await context.close();
  }
}

async function cmdLink(config) {
  const noteArg = process.argv[3];
  const day = Number(argValue('--day'));
  const noteId = extractNoteId(noteArg);
  if (!noteId) throw new Error('没从链接里解析出 noteId');
  if (!Number.isInteger(day) || day < 1) throw new Error('需要 --day <正整数>');
  const library = loadLibrary();
  const p = puzzleForDay(library, day);
  const store = createStore({ root: ROOT, config });
  store.bindNote(noteId, { day, legacyId: p.legacyId, title: p.title, url: `https://www.xiaohongshu.com/explore/${noteId}` });
  store.save();
  log(`已绑定：${noteId} → 第 ${day} 天《${p.title}》`);
}

async function cmdStatus(config) {
  const store = createStore({ root: ROOT, config });
  const notes = store.notes();
  const rows = Object.entries(notes).map(([id, n]) => ({
    noteId: id,
    day: n.day,
    title: n.title,
    已回复: store.repliedCountFor(id),
  }));
  log(`绑定笔记 ${rows.length} 篇，累计处理评论 ${store.processedCount()} 条，今日已回复 ${store.todayCount()} 条`);
  for (const r of rows) log(`  ${r.noteId}  第 ${r.day} 天《${r.title}》  已回复 ${r.已回复} 条`);
  log('话术池规模：' + JSON.stringify(templatePoolSizes()));
}

/** 跑一轮：抓评论 → 判 → 回 */
async function tick(config, { dryRun = false } = {}) {
  const library = loadLibrary();
  const store = createStore({ root: ROOT, config });
  const env = { ...loadEnvFile(ROOT), ...process.env };
  const minimaxKey = env[config.minimax.apiKeyEnv] ?? '';
  const notes = Object.entries(store.notes()).sort((a, b) => (b[1].day ?? 0) - (a[1].day ?? 0));
  if (!notes.length) {
    log('还没有绑定任何笔记，先跑 discover 或 link');
    return { replied: 0 };
  }

  const profileDir = path.resolve(ROOT, config.browserProfile);
  const context = await openContext({ profileDir, headless: config.headless });
  let replied = 0;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    for (const [noteId, info] of notes) {
      if (store.todayCount() >= config.maxRepliesPerDay) {
        log(`已达今日回复上限（${config.maxRepliesPerDay}），停止`);
        break;
      }
      const puzzle = puzzleForDay(library, info.day);
      await openNote(page, noteId);
      const comments = await readComments(page);
      const fresh = comments.filter((c) => !store.isProcessed(`${noteId}:${c.id}`));
      if (!fresh.length) continue;
      log(`《${puzzle.title}》发现 ${fresh.length} 条新评论`);

      const puzzleId = await resolvePuzzleId(store, config, puzzle.legacyId);
      const token = await ensureToken(store, config, puzzleId);

      // 单篇限额：爆款笔记评论多时不能一口气全回，避免被判成机器行为
      let noteReplied = store.repliedCountFor(noteId);
      if (noteReplied >= config.maxRepliesPerNote) {
        log(`《${puzzle.title}》已达单篇回复上限（${config.maxRepliesPerNote}），跳过剩余评论`);
        continue;
      }

      for (const comment of fresh) {
        const key = `${noteId}:${comment.id}`;
        if (store.todayCount() >= config.maxRepliesPerDay) break;
        if (noteReplied >= config.maxRepliesPerNote) {
          log(`《${puzzle.title}》已达单篇回复上限（${config.maxRepliesPerNote}），本篇剩余评论不再回复`);
          break;
        }

        const decided = await classifyComment({
          comment,
          puzzle,
          apiKey: minimaxKey,
          baseUrl: config.minimax.baseUrl,
          model: config.minimax.model,
        });
        log(`  [${decided.kind}] ${comment.author}：${comment.content.slice(0, 30)}`);

        let verdict = null;
        if (decided.kind === 'question') {
          const question = decided.question || comment.content;
          const judged = await judge({
            apiBase: config.apiBase,
            token,
            question,
            recentQas: store.qaFor(noteId),
          });
          verdict = judged.result;
          log(`    判题：${verdict}（置信度 ${judged.confidence}）`);
        }

        const reply = buildReply({ kind: decided.kind, verdict, puzzle });
        const skip = !reply || (verdict === 'uncertain' && !config.replyOnUncertain);
        if (skip) {
          // 明确不回的（ignore / 不确定且未开 uncertain 回复）：直接标记，永不再碰
          store.markProcessed(key, { kind: decided.kind, verdict, reply: '', author: comment.author });
          if (verdict === 'uncertain') log(`    判题不确定，留给你人工处理：${comment.content.slice(0, 30)}`);
          continue;
        }

        if (dryRun) {
          // 试跑不标记已处理：正式跑时这些评论还要再处理一遍
          log(`    [dry-run] 回复：${reply}`);
          continue;
        }

        await sleep(randomDelay(config.replyDelaySec));
        await replyToComment(page, comment, reply);
        // 发成功才标记：发失败（抛错）时评论仍是未处理，下次轮询会重试
        store.markProcessed(key, { kind: decided.kind, verdict, reply, author: comment.author });
        store.bumpToday();
        replied += 1;
        noteReplied += 1;
        if (decided.kind === 'question' && verdict) {
          store.pushQa(noteId, { question: decided.question || comment.content, verdict });
        }
        log(`    已回复：${reply}`);
        store.save();
      }
    }
  } finally {
    await context.close();
    store.save();
  }
  return { replied };
}

async function cmdOnce(config) {
  const r = await tick(config, { dryRun: process.argv.includes('--dry-run') });
  log(`本轮回复 ${r.replied} 条`);
}

async function cmdRun(config) {
  log('常驻服务启动，轮询间隔 ' + config.pollIntervalSec + 's；Ctrl+C 退出');
  while (true) {
    try {
      await tick(config);
    } catch (err) {
      log('本轮出错（继续下一轮）：' + (err?.message ?? err));
    }
    await sleep(config.pollIntervalSec * 1000);
  }
}

/* ------------------------------------------------------------------ 入口 */

async function main() {
  const config = loadConfig();
  const cmd = process.argv[2];
  switch (cmd) {
    case 'login':
      return await cmdLogin(config);
    case 'probe':
      return await cmdProbe(config, process.argv[3]);
    case 'discover':
      return await cmdDiscover(config);
    case 'link':
      return await cmdLink(config);
    case 'once':
      return await cmdOnce(config);
    case 'run':
      return await cmdRun(config);
    case 'status':
      return await cmdStatus(config);
    default:
      process.stderr.write(
        '用法：\n  node scripts/xhs-bot.mjs login\n  node scripts/xhs-bot.mjs discover\n  node scripts/xhs-bot.mjs link <笔记链接> --day 1\n  node scripts/xhs-bot.mjs probe <笔记链接>\n  node scripts/xhs-bot.mjs once [--dry-run]\n  node scripts/xhs-bot.mjs run\n  node scripts/xhs-bot.mjs status\n',
      );
      process.exitCode = 1;
      return undefined;
  }
}

main().catch((err) => {
  process.stderr.write(`[xhs-bot] 失败：${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
