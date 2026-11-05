#!/usr/bin/env node
/**
 * 全量批产终验：对 446 天笔记逐项核对
 *
 *   node scripts/xhs-verify-all.mjs
 *
 * 核对项：
 * 1. state：published = 446、nextIndex = 447
 * 2. 题序：第 10~446 天的日期从 2026-11-05 起严格连续 +1 天
 * 3. 每天的 outDir 都有 meta.json / 文案.txt / meta 里列出的全部卡片图
 * 4. meta.index 的题名与 library.json 顺序一致；meta.prev 与前一天题名一致
 * 5. 所有 文案.txt 无未替换的 {{占位符}}
 * 6. 收官汤底卡（2027-07-30）存在且指向第 446 题答案
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/xhs/state.json'), 'utf8'));
const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/library.json'), 'utf8'));

const problems = [];
const fail = (msg) => problems.push(msg);

if (state.history.length !== library.length) fail(`history ${state.history.length} != 题库 ${library.length}`);
if (state.nextIndex !== library.length + 1) fail(`nextIndex ${state.nextIndex} != ${library.length + 1}`);

const byIndex = new Map(state.history.map((h) => [h.index, h]));
let pngCount = 0;
for (let index = 1; index <= library.length; index++) {
  const h = byIndex.get(index);
  if (!h) {
    fail(`第 ${index} 天缺失`);
    continue;
  }
  if (h.title !== library[index - 1].title) {
    fail(`第 ${index} 天题名不符：${h.title} != ${library[index - 1].title}`);
  }
  // 日期排布：第 10 天起 = 2026-11-05 + (index-10) 天
  const expect = new Date(Date.UTC(2026, 10, 5 + index - 10)).toISOString().slice(0, 10);
  if (index >= 10 && h.date !== expect) fail(`第 ${index} 天日期 ${h.date} != 期望 ${expect}`);

  const dir = path.join(ROOT, h.outDir);
  for (const name of ['meta.json', '文案.txt']) {
    if (!fs.existsSync(path.join(dir, name))) fail(`${h.date} 缺 ${name}`);
  }
  if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (meta.index !== index) fail(`${h.date} meta.index ${meta.index} != ${index}`);
  for (const card of meta.cards ?? []) {
    const p = path.join(dir, card.file);
    if (!fs.existsSync(p)) fail(`${h.date} 缺卡片 ${card.file}`);
    else pngCount++;
  }
  const copy = fs.readFileSync(path.join(dir, '文案.txt'), 'utf8');
  if (copy.includes('{{')) fail(`${h.date} 文案有未替换占位符`);
  if (index >= 2) {
    const prev = byIndex.get(index - 1);
    if (meta.prev && prev && meta.prev.title !== prev.title) {
      fail(`${h.date} 汤底题名 ${meta.prev.title} != 前一天 ${prev.title}`);
    }
  }
}

// 收官卡（日期 = 第 446 天的下一天）
const finaleDate = new Date(Date.UTC(2026, 10, 5 + library.length - 10 + 1)).toISOString().slice(0, 10);
const finaleDir = path.join(ROOT, 'data/xhs/output', finaleDate);
if (!fs.existsSync(path.join(finaleDir, 'meta.json'))) {
  fail(`收官卡 ${finaleDate} 缺 meta.json`);
} else {
  const meta = JSON.parse(fs.readFileSync(path.join(finaleDir, 'meta.json'), 'utf8'));
  if (!meta.finale || meta.index !== library.length) fail('收官卡 meta 标记不对');
  const last = library[library.length - 1];
  if (meta.title !== last.title) fail(`收官卡题名 ${meta.title} != ${last.title}`);
  for (const card of meta.cards ?? []) {
    if (!fs.existsSync(path.join(finaleDir, card.file))) fail(`收官卡缺卡片 ${card.file}`);
    else pngCount++;
  }
  // 答案全文在卡片图里；文案.txt 只需要提到收官与题名
  const finaleCopy = fs.readFileSync(path.join(finaleDir, '文案.txt'), 'utf8');
  if (!finaleCopy.includes(last.title)) fail('收官卡文案未提及最后一天题名');
}

// 批产清单
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/xhs/output/batch-manifest.json'), 'utf8'));
if (manifest.fullHistory.length !== library.length) fail(`清单 fullHistory ${manifest.fullHistory.length}`);

console.log(`卡片图总数：${pngCount}`);
console.log(`日期区间：第 10 天 ${byIndex.get(10)?.date} → 第 ${library.length} 天 ${byIndex.get(library.length)?.date}，收官卡 ${finaleDate}`);
console.log(`批产警告：${manifest.warnings.length} 条`);
if (problems.length) {
  console.log(`\n发现问题 ${problems.length} 处：`);
  for (const p of problems.slice(0, 50)) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\n终验通过：446 天笔记 + 收官汤底卡全部落盘，题序与日期排布一致。');
