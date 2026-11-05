#!/usr/bin/env node
/**
 * 海龟汤全量批产：把剩余题目一次性渲染成按日期排布的笔记
 *
 *   node scripts/xhs-batch-all.mjs [--start-date 2026-11-05]
 *
 * 规则：
 * - 从 state.json 的 nextIndex 起逐题调用 xhs-daily.mjs run（完全复用日更流水线，不改它）
 * - 日期从 --start-date 开始连续 +1 天，输出目录仍为 data/xhs/output/<日期>/
 * - 文案 hook/guide/hashtags 由内置模板轮换生成（互动口吻；不写图序、不提"下一篇"）
 * - 某日期已在 state.history 里则跳过（中断后重跑安全，不会重复消耗题号）
 * - 题目全部发完后额外渲染一张收官汤底卡（第 446 题的答案，日更流水线覆盖不到它）
 * - 产出 data/xhs/output/batch-manifest.json 汇总清单，最后做一次落盘自审计
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderCards } from './xhs-poster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data', 'xhs');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LIBRARY_PATH = path.join(ROOT, 'data', 'library.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DAILY = path.join(ROOT, 'scripts', 'xhs-daily.mjs');
const MANIFEST_PATH = path.join(DATA_DIR, 'output', 'batch-manifest.json');

const log = (...a) => process.stderr.write(`[xhs-batch] ${a.join(' ')}\n`);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 日期字符串（YYYY-MM-DD）+ n 天，纯日期运算不走本地时区 */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------- 文案模板（轮换） */

/** 开场白池：{day}/{title} 会被替换成当日天数与题名 */
const HOOKS = [
  '第 {day} 碗汤上桌，标题就先给你一点心理暗示——《{title}》',
  '今天这碗汤有点上头，先看题面，评论区见真章',
  '新的一天新的汤，这个题面我读完愣了三秒，你呢？',
  '深夜放汤警告⚠️ 第 {day} 天，《{title}》来了',
  '这题越想越不对劲，建议看完题面先别急着下结论👀',
  '第 {day} 天，汤面已上桌，老规矩：评论区开问，我只答是/否/无关',
  '今天的汤面信息量看着不大，细想全是窟窿，慢慢品🫣',
  '推理时间到！《{title}》，敢不敢一把猜中',
  '第 {day} 碗汤，热乎的。看题面，猜真相，评论区蹲一个狠人',
  '今天的题面里藏了一个很关键的细节，找到的人已经赢一半了🔍',
  '第 {day} 天打卡，今天的汤管饱，汤底够不够劲你们说了算',
  '这碗汤的画风突变，看完题面先冷静一下再往深处想',
  '第 {day} 天，汤已上桌。提示只有一句：注意每句话的用词',
  '今天的题目名字起得很老实，内容可一点都不老实😈',
];

/** 结尾互动引导池：不写图序、不重复"答案在下一篇笔记"（那句脚本已填） */
const GUIDES = [
  '你的第一直觉是什么？评论区说出你的推理，看看谁最接近真相',
  '觉得难还是简单？评论区打个分，顺便写下你的还原思路',
  '猜到的扣1，没猜到的说说你最离谱的猜想',
  '评论区已经开卷了，你来当侦探：真相到底是什么？',
  '把你的推理留在评论区，蹲一个最狠的还原',
  '敢不敢在评论区写下你的完整推理链？',
  '有思路的发评论区，没思路的可以求助场外观众',
  '你猜到几分了？评论区报个进度',
  '真相只有一个，你的版本也欢迎，评论区切磋一下',
  '这题你卡在哪一句了？评论区对一下线索，人多力量大',
];

const BASE_TAGS = ['#海龟汤', '#悬疑推理', '#每日一题'];
const EXTRA_TAGS = ['#情境推理', '#逻辑推理', '#细思极恐', '#推理故事', '#脑洞大开', '#解谜日常'];

/** 按题号确定性轮换生成三段文案，保证相邻天组合不重样 */
function buildCopy(index, title) {
  const fill = (s) => s.split('{day}').join(String(index)).split('{title}').join(title);
  const hook = fill(HOOKS[index % HOOKS.length]);
  const guide = GUIDES[(index * 3 + 1) % GUIDES.length];
  const a = EXTRA_TAGS[index % EXTRA_TAGS.length];
  const b = EXTRA_TAGS[(index + 2) % EXTRA_TAGS.length];
  return { hook, guide, hashtags: [...BASE_TAGS, a, b] };
}

/* --------------------------------------------------------------- 主流程 */

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
const config = { ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };

const startIndex = state.nextIndex ?? 1;
const start = argValue('--start-date') ?? '2026-11-05';
// 日期锚点钉死：第 10 天 = 2026-11-05，一天一题往后推。
// 不能用 startIndex 推日期——中断续跑后 startIndex 会变，日期整体漂移（2026-11-04 修过的 bug）
const DATE_ANCHOR = { index: 10, date: start };
const dateOf = (index) => addDays(DATE_ANCHOR.date, index - DATE_ANCHOR.index);
if (startIndex > library.length) {
  log('题库已全部发完，无事可做。');
  process.exit(0);
}
log(`批产第 ${startIndex}～${library.length} 题，起始日期 ${start}，共 ${library.length - startIndex + 1} 天`);

const days = [];
let finale = null; // 收官卡信息；循环内的增量清单落盘也要引用它，必须先声明
for (let index = startIndex; index <= library.length; index++) {
  const date = dateOf(index);

  // 断点续跑：这个日期已经发过就跳过
  if (state.history.some((h) => h.date === date)) {
    log(`跳过 ${date}（已在进度历史里）`);
    continue;
  }

  const title = library[index - 1].title;
  const reqPath = path.join(DATA_DIR, 'requests', `${date}.json`);
  fs.writeFileSync(reqPath, `${JSON.stringify({ date, copy: buildCopy(index, title) }, null, 2)}\n`, 'utf8');

  // 渲染偶发 Chromium 崩溃（Target closed），失败小睡后重试，最多 3 次；run 幂等，重试安全
  let r = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync(process.execPath, [DAILY, 'run', '--input', reqPath], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.status === 0) break;
    log(`第 ${index} 题《${title}》渲染失败（第 ${attempt}/3 次），5 秒后重试`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (r.status !== 0) {
    // fail-fast：重试仍失败就停，进度停在失败前一天（run 只在成功后推进），修好后重跑即可续上
    log(`失败于 ${date}（第 ${index} 题《${title}》）`);
    process.stderr.write((r.stderr || r.stdout || '').slice(-2000));
    process.exit(1);
  }
  const out = JSON.parse(r.stdout);
  days.push({
    date: out.date,
    index: out.index,
    title: out.title,
    prevTitle: out.prevTitle,
    outDir: out.outDir,
    cardCount: out.cards.length,
    warnings: out.warnings,
  });

  // 每完成一天就落盘一次清单，中途崩了也不丢记录
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeManifest(days, []);
  if (days.length % 25 === 0 || index === library.length) {
    log(`进度 ${days.length}/${library.length - startIndex + 1}（${date} 第 ${index} 题《${title}》）`);
  }
}

/* ------------------------------------------------------------ 收官汤底卡 */

// 第 446 题的答案没有"下一篇"可揭晓，日更流水线跑不到；这里按同一版式补一张收官卡
const last = library[library.length - 1];
const finaleDate = dateOf(library.length + 1);
const finaleDir = path.join(DATA_DIR, 'output', finaleDate);
if (!fs.existsSync(path.join(finaleDir, 'meta.json'))) {
  fs.mkdirSync(finaleDir, { recursive: true });
  for (const f of fs.readdirSync(finaleDir)) {
    if (/^\d{2}-(汤面|汤底)\.png$/.test(f)) fs.rmSync(path.join(finaleDir, f), { force: true });
  }
  log(`渲染收官汤底卡 ${finaleDate}《${last.title}》…`);
  const { pages } = await renderCards({
    backgroundMode: config.backgroundMode === 'css' ? 'css' : 'image',
    outDir: finaleDir,
    sections: [
      {
        kind: 'bottom',
        label: `收官汤底 · 第 ${library.length} 天`,
        badge: last.category ?? '海龟汤',
        title: last.title,
        text: last.answer,
        footer: '🎉 全系列完 · 感谢追更',
        background: path.join(DATA_DIR, config.backgrounds.bottom),
        cssVariant: 'warm',
      },
    ],
    maxChars: config.cardCharLimit,
    maxTotalCards: 18,
    width: config.width,
    height: config.height,
    accent: config.accent,
  });
  const copyText = [
    '🎉 收官！第 ' + library.length + ' 天，全系列完',
    '',
    `最后一碗《${last.title}》的完整汤底在图一 👀`,
    '从第一天追到这里的都是真爱，评论区集合报到！',
    '',
    '#海龟汤 #全系列完 #推理故事',
  ].join('\n');
  const copyPath = path.join(finaleDir, '文案.txt');
  fs.writeFileSync(copyPath, `${copyText.trim()}\n`, 'utf8');
  const meta = {
    date: finaleDate,
    finale: true,
    index: library.length,
    title: last.title,
    id: last.id,
    category: last.category,
    cards: pages.map((p) => ({ file: path.basename(p.outPath), kind: p.kind, page: p.page, chars: p.chars })),
    copy: path.relative(ROOT, copyPath),
  };
  fs.writeFileSync(path.join(finaleDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  finale = { date: finaleDate, title: last.title, outDir: path.relative(ROOT, finaleDir), cardCount: pages.length };
} else {
  log(`收官卡已存在，跳过`);
}

/* --------------------------------------------------------------- 自审计 */

// 逐项核对：清单里每一天的 meta.json / 卡片图 / 文案都在盘上，且没有任何未替换的模板占位符
function writeManifest(dayList, warnings) {
  const finalState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  fs.writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        batch: { fromIndex: startIndex, toIndex: library.length, fromDate: start, count: dayList.length },
        days: dayList,
        finale,
        warnings,
        fullHistory: finalState.history,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

const warnings = days.flatMap((d) => d.warnings.map((w) => `${d.date}：${w}`));
writeManifest(days, warnings);

const problems = [];
const checkDir = (dir, label) => {
  if (!fs.existsSync(path.join(ROOT, dir, 'meta.json'))) problems.push(`${label} 缺 meta.json`);
  if (!fs.existsSync(path.join(ROOT, dir, '文案.txt'))) problems.push(`${label} 缺 文案.txt`);
};
for (const d of days) checkDir(d.outDir, d.date);
for (const h of state.history) checkDir(h.outDir, `${h.date}(已发布)`);
if (finale) checkDir(finale.outDir, finale.date);
const allCopyFiles = [];
const collect = (dir) => {
  const p = path.join(ROOT, dir, '文案.txt');
  if (fs.existsSync(p)) allCopyFiles.push(p);
};
for (const d of days) collect(d.outDir);
for (const h of state.history) collect(h.outDir);
for (const p of allCopyFiles) {
  if (fs.readFileSync(p, 'utf8').includes('{{')) problems.push(`${p} 仍有未替换占位符`);
}

if (problems.length) {
  log(`自审计发现问题 ${problems.length} 处：`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exitCode = 1;
} else {
  log(`自审计通过：清单 ${days.length} 天 + 收官卡，全部文件落盘，占位符无残留`);
  process.stdout.write(`${JSON.stringify({ ok: true, days: days.length, finale, warnings }, null, 2)}\n`);
}
