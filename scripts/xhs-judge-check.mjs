/**
 * 判题链路自检 —— 不开浏览器，只验「题库映射 → 匿名凭证 → 判题」三步。
 *
 * 用途：上线 bot 前确认自家 API 通、题库已入库、判题能出结果。
 *
 *   node scripts/xhs-judge-check.mjs [legacyId] [--api http://localhost:8080/api/v1]
 *
 * 不带参数时用 `real-finish-line`（《终点线》，第 1 天那题）。
 */
import { buildPuzzleIdMap, createSession, judge } from './xhs-bot-agent.mjs';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apiBase = argValue('--api', 'http://localhost:8080/api/v1');
const legacyId = process.argv[2]?.startsWith('--') ? 'real-finish-line' : (process.argv[2] ?? 'real-finish-line');

const log = (s) => process.stdout.write(`${s}\n`);

log(`[check] API = ${apiBase}`);

const map = await buildPuzzleIdMap({ apiBase });
log(`[check] 题库映射 ${map.size} 条`);
if (!map.size) throw new Error('题库是空的：API 没连上，或题库没导入（pnpm db:seed）');

const puzzleId = map.get(legacyId);
if (!puzzleId) throw new Error(`题库里没有 ${legacyId}（已知的 legacyId 形如 real-finish-line）`);
log(`[check] ${legacyId} -> ${puzzleId}`);

const token = await createSession({ apiBase, puzzleId });
log(`[check] 匿名凭证长度 ${token.length}`);

const cases = [
  '那台游戏机是爸爸送的吗？',
  '凶手是妈妈吗？',
  '这个故事发生在日本吗？',
  '今天天气怎么样',
];
for (const q of cases) {
  const r = await judge({ apiBase, token, question: q, recentQas: [] });
  log(`[check] "${q}" -> ${r.result} (置信度 ${r.confidence})`);
}
log('[check] 判题链路 OK');
