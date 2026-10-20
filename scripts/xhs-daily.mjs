#!/usr/bin/env node
/**
 * 小红书海龟汤日更流水线
 *
 *   node scripts/xhs-daily.mjs plan [--date YYYY-MM-DD]   # 打印当天要发的素材事实
 *   node scripts/xhs-daily.mjs run --input <请求.json>     # 分卡渲染 + 出文案 + 推进进度
 *   node scripts/xhs-daily.mjs background [--force]        # 生成/刷新统一的无文字背景图
 *   node scripts/xhs-daily.mjs status                      # 看发布进度
 *   node scripts/xhs-daily.mjs reset --index N             # 手动设定下一题位置（1 起）
 *
 * 进度只在 run 全部成功后推进；同一天重跑不重复消耗题号。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderCards, makeCoverJpeg } from './xhs-poster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data', 'xhs');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const TEMPLATE_PATH = path.join(DATA_DIR, 'copy-template.txt');
const LIBRARY_PATH = path.join(ROOT, 'data', 'library.json');
const SOURCES_PATH = path.join(ROOT, 'data', 'sources.md');

const DEFAULTS = {
  width: 1080,
  height: 1440,
  accent: '#e3b273',
  resolution: '2K',
  aspectRatio: '3:4',
  /** 每张卡片的正文字数上限（实际按总量均分，因此每张大致在这个区间） */
  cardCharLimit: 130,
  backgroundMode: 'image',
  backgrounds: {
    face: 'assets/background-face.jpg',
    bottom: 'assets/background-bottom.jpg',
  },
  backgroundPrompts: {
    face:
      'Dark horror illustration, an abandoned corridor of an old building at night, peeling wallpaper, a single distant dim light, thick fog pooling on the floor, a cracked mirror on the wall, cold moonlight through a broken window, cold desaturated blue-grey palette, deep shadows, volumetric haze, film grain, strong vignette, calm empty center of the frame, no people, no text, no letters, no numbers, no signage, no watermark, vertical composition',
    bottom:
      'Dark horror illustration, a heavy old door at the end of a pitch-black corridor cracking open, a sliver of warm amber-red light spilling across the dusty floor, peeling paint, cobwebs, a faintly swinging bulb, long cast shadows, blood-red and amber palette, deep shadows, volumetric haze, film grain, strong vignette, calm empty center of the frame, no people, no text, no letters, no numbers, no signage, no watermark, vertical composition',
  },
  hashtags: ['#海龟汤', '#悬疑推理', '#每日一题', '#情境推理', '#逻辑推理'],
};

/* ------------------------------------------------------------------ 基础 IO */

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');

function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_PATH)) Object.assign(cfg, readJson(CONFIG_PATH));
  return cfg;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { nextIndex: 1, history: [], lastPublished: null };
  const s = readJson(STATE_PATH);
  return { nextIndex: s.nextIndex ?? 1, history: s.history ?? [], lastPublished: s.lastPublished ?? null };
}

function todayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hasFlag = (flag) => process.argv.includes(flag);

/* ------------------------------------------------------------- 题库与来源 */

function loadLibrary() {
  return readJson(LIBRARY_PATH);
}

/** 解析 data/sources.md 的逐题来源表：编号 = library.json 中的位置 */
function parseSources() {
  const map = new Map();
  const text = fs.readFileSync(SOURCES_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    map.set(m[2], { index: Number(m[1]), title: m[3], batch: m[4], source: m[5] });
  }
  return map;
}

const BATCH_SOURCE = {
  天堂: '改编自 B 站 UP 主「尕丶天堂」饭堂时刻系列投稿文字稿',
  小小耶: '改编自 B 站 UP 主「小小耶」海龟汤视频投稿文字稿',
  许二木: '改编自抖音创作者「许二木」海龟汤系列视频字幕抽取稿',
  首发: '平台原创题目',
  扩展: '平台原创题目',
};

/** 作者声明：改编题注明原作者与改写方式，原创题注明参考出处 */
function authorStatement(src) {
  if (!src) return '📎 出处：平台题目库首发，版权归原作者所有。';
  const base = BATCH_SOURCE[src.batch];
  if (!base) return '📎 出处：平台题目库首发，版权归原作者所有。';
  const link = /\[原作《([^》]+)》\]/.exec(src.source ?? '');
  const rewrite = /·\s*([^·|]+?)\s*$/.exec(src.source ?? '');
  if (base.startsWith('改编自')) {
    let s = `📎 出处：本题${base}（原作《${link ? link[1] : src.title}》`;
    s += rewrite ? `，${rewrite[1]}）` : '）';
    s += '。原作版权归原作者所有。';
    return s;
  }
  const note = link ? '' : (src.source ?? '').trim();
  let s = `📎 出处：本题为${base}`;
  if (note) s += `（${note}）`;
  s += '，版权归原作者所有。';
  return s;
}

function puzzleFacts(puzzle, sources) {
  const src = sources.get(puzzle.id) ?? null;
  return {
    id: puzzle.id,
    title: puzzle.title,
    category: puzzle.category,
    difficulty: puzzle.difficulty,
    batch: src?.batch ?? null,
    source: src?.source ?? null,
    statement: authorStatement(src),
  };
}

/* ------------------------------------------------------------- mcode-tools */

function resolveMcodeTools() {
  if (process.env.MCODE_TOOLS) return process.env.MCODE_TOOLS;
  const isWin = process.platform === 'win32';
  const names = isWin ? ['mcode-tools.cmd', 'mcode-tools.exe', 'mcode-tools'] : ['mcode-tools'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [path.join(os.homedir(), '.minimax', 'bin')];
  for (const d of [...extra, ...dirs]) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* 忽略 */
      }
    }
  }
  return 'mcode-tools';
}

function cli(args, { timeout = 900000 } = {}) {
  const bin = resolveMcodeTools();
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const cmdLine = [q(bin), ...args.map(q)].join(' ');
  try {
    return execSync(cmdLine, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim().slice(0, 800);
    throw new Error(`调用 ${bin} 失败：${detail}`);
  }
}

const IMAGE_TOOL = 'connector__matrix__generate_image';

/** 生成一张图并下载到指定路径 */
async function generateImage({ prompt, config, outFile }) {
  const argsFile = `${outFile}.args.json`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    argsFile,
    JSON.stringify({
      requests: [{ prompt, aspect_ratio: config.aspectRatio, resolution: config.resolution }],
    }),
    'utf8',
  );
  let raw = '';
  try {
    raw = cli(['connector', 'call', IMAGE_TOOL, '--args-file', argsFile]);
  } finally {
    try {
      fs.unlinkSync(argsFile);
    } catch {
      /* 忽略 */
    }
  }
  const result = JSON.parse(raw);
  const success = result.success_items?.[0];
  if (!success) throw new Error(`生图失败：${JSON.stringify(result.failed_items ?? result)}`);
  const asset = JSON.parse(cli(['get_asset_url', success.node_id]));
  const res = await fetch(asset.download_url);
  if (!res.ok) throw new Error(`下载生图失败：HTTP ${res.status}`);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return { outFile, nodeId: success.node_id };
}

/* ------------------------------------------------------------------ 文案 */

/** 阿拉伯数字 → 中文数字（图一 / 图二 … 图十八） */
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function chineseNum(n) {
  if (n <= 10) return n === 10 ? '十' : CN_DIGITS[n];
  if (n < 20) return `十${CN_DIGITS[n - 10]}`;
  return CN_DIGITS[Math.floor(n / 10)] + `十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
}

/** 图序文案：单张 "图二"，多张 "图二、图三" */
function imageRange(start, end) {
  const a = `图${chineseNum(start)}`;
  if (!end || end <= start) return a;
  return `${a}、图${chineseNum(end)}`;
}

function buildCopy({ template, day, today, prev, statement, copy, prevImageStart, prevImageEnd }) {
  const tags = Array.isArray(copy.hashtags)
    ? copy.hashtags.filter(Boolean).join(' ')
    : String(copy.hashtags ?? '').trim();
  // 汤底起始图序由渲染后的真实页数决定：汤面占 N 张 → 汤底从第 N+1 张开始
  const range = prevImageStart ? imageRange(prevImageStart, prevImageEnd) : '';
  const prevNote = prev
    ? `昨天那碗《${prev.title}》的完整汤底，从${range}开始 👀\n今天的答案在下一篇笔记揭晓～`
    : '第一篇开张！今天只有汤面，答案在下一篇笔记揭晓～';
  const filled = {
    hook: copy.hook ?? '',
    day: String(day),
    title: today.title,
    story: today.story,
    prevTitle: prev?.title ?? '',
    prevNote,
    prevImageStart: range,
    authorStatement: statement,
    guide: copy.guide ?? '',
    hashtags: tags,
  };
  let text = template;
  for (const [k, v] of Object.entries(filled)) {
    text = text.split(`{{${k}}}`).join(v);
  }
  // 第二轮：替换"写在自己文案里"的占位符
  // （第一轮里 guide 的值是被整体代入的，它内部的 {{prevImageStart}} 此时还没被解析）
  for (const [k, v] of Object.entries(filled)) {
    text = text.split(`{{${k}}}`).join(v);
  }
  return `${text.trim()}\n`;
}

/* ------------------------------------------------------------------ 命令 */

function commandPlan(dateArg) {
  const config = loadConfig();
  const state = loadState();
  const library = loadLibrary();
  const sources = parseSources();
  const date = dateArg ?? todayStr();
  const prior = state.history.find((h) => h.date === date);
  const index = prior ? prior.index : state.nextIndex;
  if (index > library.length) throw new Error('题库已发完（446 题全部用尽）。');

  const today = library[index - 1];
  const prev = index > 1 ? library[index - 2] : null;
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const bgPath = path.join(DATA_DIR, config.backgrounds.face);

  const plan = {
    date,
    index,
    total: library.length,
    seriesDay: index,
    today: { ...puzzleFacts(today, sources), story: today.story },
    prev: prev ? { index: index - 1, ...puzzleFacts(prev, sources), answer: prev.answer } : null,
    backgrounds: Object.fromEntries(
      Object.entries(config.backgrounds).map(([k, v]) => [k, path.relative(ROOT, path.join(DATA_DIR, v))]),
    ),
    cardCharLimit: config.cardCharLimit,
    copyTemplate: template,
    requestPath: path.relative(ROOT, path.join(DATA_DIR, 'requests', `${date}.json`)),
    requestExample: {
      date,
      copy: {
        hook: '<开场白，1-2 句，轻松口语，可带 emoji>',
        guide: '<结尾引导评论区的 1-2 句，不要写"图几"、不要重复"答案在下一篇笔记">',
        hashtags: config.hashtags,
      },
    },
    copyNotes: [
      '图序（"图二"之类）由脚本在渲染后按真实张数自动计算，guide 里不要自己写图序。',
      '如果确实要在自己的文案里引用汤底图序，用占位符 {{prevImageStart}}，脚本会替换成"图二"或"图二、图三"。',
      'prevNote（"昨天那碗…的完整汤底，从图X开始" + "今天的答案在下一篇笔记揭晓"）脚本已填好，不要在 guide 里重复。',
    ],
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

async function commandBackground() {
  const config = loadConfig();
  const kind = argValue('--kind') === 'bottom' ? 'bottom' : 'face';
  const outPath = path.join(DATA_DIR, config.backgrounds[kind]);
  if (fs.existsSync(outPath) && !hasFlag('--force')) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, skipped: true, kind, path: path.relative(ROOT, outPath) }, null, 2)}\n`,
    );
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-bg-'));
  const raw = path.join(tmpDir, 'raw.png');
  process.stderr.write(`[xhs] 生成${kind === 'face' ? '汤面' : '汤底'}背景图…\n`);
  await generateImage({ prompt: config.backgroundPrompts[kind], config, outFile: raw });
  await makeCoverJpeg({
    srcPath: raw,
    outPath,
    width: config.width,
    height: config.height,
    quality: 88,
  });
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, kind, path: path.relative(ROOT, outPath), bytes: fs.statSync(outPath).size }, null, 2)}\n`,
  );
}

async function commandRun(inputArg) {
  if (!inputArg) throw new Error('缺少 --input <请求.json>');
  const config = loadConfig();
  const state = loadState();
  const library = loadLibrary();
  const sources = parseSources();

  const input = JSON.parse(fs.readFileSync(path.resolve(ROOT, inputArg), 'utf8'));
  const date = input.date ?? todayStr();
  const prior = state.history.find((h) => h.date === date);
  const index = prior ? prior.index : state.nextIndex;
  if (index > library.length) throw new Error('题库已发完（446 题全部用尽）。');

  const today = library[index - 1];
  const prev = index > 1 ? library[index - 2] : null;

  const backgroundMode = config.backgroundMode === 'css' ? 'css' : 'image';
  const bgOf = (kind) => path.join(DATA_DIR, config.backgrounds[kind]);
  if (backgroundMode === 'image') {
    for (const kind of ['face', ...(prev ? ['bottom'] : [])]) {
      if (!fs.existsSync(bgOf(kind))) {
        throw new Error(
          `缺少${kind === 'face' ? '汤面' : '汤底'}背景图（${config.backgrounds[kind]}），先执行：node scripts/xhs-daily.mjs background --kind ${kind}`,
        );
      }
    }
  }

  const outDir = path.join(DATA_DIR, 'output', date);
  fs.mkdirSync(outDir, { recursive: true });
  // 清掉上一轮遗留的卡片
  for (const f of fs.readdirSync(outDir)) {
    if (/^\d{2}-(汤面|汤底)\.png$/.test(f)) {
      try {
        fs.unlinkSync(path.join(outDir, f));
      } catch {
        /* 忽略 */
      }
    }
  }

  const sections = [
    {
      kind: 'face',
      label: `第 ${index} 天`,
      badge: today.category ?? '海龟汤',
      title: today.title,
      text: today.story,
      footer: '🔒 汤底在下一篇笔记揭晓',
      background: bgOf('face'),
      cssVariant: 'cool',
    },
  ];
  if (prev) {
    sections.push({
      kind: 'bottom',
      label: `昨日汤底 · 第 ${index - 1} 天`,
      badge: prev.category ?? '海龟汤',
      title: prev.title,
      text: prev.answer,
      footer: '今日汤面在上一张图 👀',
      background: bgOf('bottom'),
      cssVariant: 'warm',
    });
  }

  process.stderr.write(`[xhs] ${date} 第 ${index} 天《${today.title}》渲染卡片…\n`);
  const { pages, relaxed } = await renderCards({
    backgroundMode,
    outDir,
    sections,
    maxChars: config.cardCharLimit,
    maxTotalCards: 18,
    width: config.width,
    height: config.height,
    accent: config.accent,
  });

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  // 汤底起始图序：今日汤面占了前 N 张，汤底就是第 N+1 张开始
  const faceCount = pages.filter((p) => p.kind === 'face').length;
  const bottomCount = pages.filter((p) => p.kind === 'bottom').length;
  const copyText = buildCopy({
    template,
    day: index,
    today,
    prev,
    statement: authorStatement(sources.get(today.id)),
    copy: input.copy ?? {},
    prevImageStart: prev ? faceCount + 1 : 0,
    prevImageEnd: prev ? faceCount + bottomCount : 0,
  });
  const copyPath = path.join(outDir, '文案.txt');
  fs.writeFileSync(copyPath, copyText, 'utf8');

  const overLimit = pages.filter((p) => p.chars > config.cardCharLimit);
  const meta = {
    date,
    index,
    title: today.title,
    id: today.id,
    category: today.category,
    statement: authorStatement(sources.get(today.id)),
    prev: prev ? { index: index - 1, id: prev.id, title: prev.title } : null,
    cardCharLimit: config.cardCharLimit,
    cards: pages.map((p) => ({
      file: path.basename(p.outPath),
      kind: p.kind,
      page: p.page,
      chars: p.chars,
      totalChars: p.totalChars,
      fontSize: p.fontSize,
    })),
    copy: path.relative(ROOT, copyPath),
  };
  writeJson(path.join(outDir, 'meta.json'), meta);

  if (!prior && !hasFlag('--dry-run')) {
    state.nextIndex = index + 1;
    state.history.push({
      date,
      index,
      id: today.id,
      title: today.title,
      outDir: path.relative(ROOT, outDir),
    });
    state.lastPublished = date;
    writeJson(STATE_PATH, state);
  }

  const warnings = [];
  if (overLimit.length) warnings.push(`${overLimit.length} 张卡片超过 ${config.cardCharLimit} 字上限`);
  if (relaxed) warnings.push('本期题目过长，字数上限已放宽以把张数控制在 18 张以内');
  if (pages.length > 18) warnings.push(`本期 ${pages.length} 张图，超过小红书 18 张上限，建议把汤底并入文案`);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        date,
        index,
        dryRun: hasFlag('--dry-run'),
        total: library.length,
        title: today.title,
        prevTitle: prev?.title ?? null,
        cards: pages.map((p) => ({
          file: path.relative(ROOT, p.outPath),
          kind: p.kind,
          page: p.page,
          chars: p.chars,
          totalChars: p.totalChars,
        })),
        copy: path.relative(ROOT, copyPath),
        outDir: path.relative(ROOT, outDir),
        warnings,
      },
      null,
      2,
    )}\n`,
  );
}

function commandStatus() {
  const state = loadState();
  const library = loadLibrary();
  const last = state.history[state.history.length - 1] ?? null;
  process.stdout.write(
    `${JSON.stringify(
      {
        nextIndex: state.nextIndex,
        published: state.history.length,
        total: library.length,
        remaining: Math.max(0, library.length - state.nextIndex + 1),
        lastPublished: state.lastPublished,
        last: last ? { date: last.date, index: last.index, title: last.title } : null,
      },
      null,
      2,
    )}\n`,
  );
}

function commandReset(indexArg) {
  const state = loadState();
  const n = Number(indexArg);
  if (!Number.isInteger(n) || n < 1) throw new Error('--index 需要 1 起的整数');
  state.nextIndex = n;
  writeJson(STATE_PATH, state);
  commandStatus();
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'plan':
      return commandPlan(argValue('--date'));
    case 'run':
      return await commandRun(argValue('--input'));
    case 'background':
      return await commandBackground();
    case 'status':
      return commandStatus();
    case 'reset':
      return commandReset(argValue('--index'));
    default:
      process.stderr.write(
        '用法：\n  node scripts/xhs-daily.mjs plan [--date YYYY-MM-DD]\n  node scripts/xhs-daily.mjs run --input <请求.json> [--dry-run]\n  node scripts/xhs-daily.mjs background [--force]\n  node scripts/xhs-daily.mjs status\n  node scripts/xhs-daily.mjs reset --index N\n',
      );
      process.exitCode = 1;
      return undefined;
  }
}

main().catch((err) => {
  process.stderr.write(`[xhs] 失败：${err?.message ?? err}\n`);
  process.exitCode = 1;
});
