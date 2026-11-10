/** 真实线上单人接口检查：一次提问和一次还原，结果按正式契约校验，禁止打印汤底或凭据。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  puzzleListItemSchema,
  soloSessionResponseSchema,
  soloJudgeResponseSchema,
  soloSolveResponseSchema,
  errorBodySchema, canRateSoloPuzzle,
} from '@jev/contracts';
import { beginSoloTurn, completeSoloTurn, failSoloTurn, recoverInterruptedSolo, savedGameSchema, type SavedGame } from '../src/solo-state.js';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8')) as { apiBaseUrl: string };
const origin = process.env.TAPTAP_API_BASE_URL ?? config.apiBaseUrl;
let checks = 0;
function check(value: unknown, label: string): asserts value { assert(value, label); checks++; console.log(`通过：${label}`); }
async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'X-Jev-Language': 'zh' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.ok, true, `${path}: HTTP ${response.status}`);
  return z.object({ data: schema }).parse(await response.json()).data;
}

const list = await call('/puzzles?language=zh&sort=popular&limit=2', z.object({ items: z.array(puzzleListItemSchema), nextCursor: z.string().nullable() }));
assert.ok(list.items.length > 0, '线上题库为空');
const puzzle = list.items[0]!;
const session = await call('/solo/sessions', soloSessionResponseSchema, { puzzleId: puzzle.id, versionId: puzzle.versionId, language: 'zh' });
assert.equal(session.puzzleId, puzzle.id);
check(session.puzzleId === puzzle.id, '真实题库与固定版本单人开局');
let game: SavedGame = { session, turns: [], answer: null, drafts: { ask: '', solve: '' }, mode: 'ask', hintsUsed: 0, useLargeModel: false };
const question = '故事中有人类角色吗？'; const questionId = randomUUID();
const sending = beginSoloTurn(game, questionId, question);
check(sending.turns[0]?.status === 'sending' && sending.drafts.ask === question, '判题前记录回合编号和输入');
assert.throws(() => beginSoloTurn(sending, randomUUID(), question)); check(true, '存在进行中判题时不能再次提交');
const stored = savedGameSchema.parse(JSON.parse(JSON.stringify(sending)));
const interrupted = recoverInterruptedSolo(stored);
check(interrupted.turns[0]?.status === 'interrupted' && interrupted.drafts.ask === question, '重启后标明中断并保留草稿');
check(!canRateSoloPuzzle(interrupted.answer, interrupted.turns), '中断的尝试不开放评价');

const judged = await call('/solo/judge', soloJudgeResponseSchema, { token: session.token, question, recentQas: [] });
game = completeSoloTurn(sending, questionId, judged);
check(game.turns.length === 1 && game.turns[0]?.id === questionId && game.turns[0]?.status === 'succeeded', '真实 AI 结果更新原回合，不重复添加');
check(game.turns[0]?.confidence === judged.confidence && game.drafts.ask === '', '置信度和清空已提交草稿正确');
check(sending.turns[0]?.status === 'sending', '完成回合不改写此前的不可变快照');
const edited = completeSoloTurn({ ...sending, drafts: { ...sending.drafts, ask: puzzle.surface.slice(0, 500) } }, questionId, judged);
check(edited.drafts.ask === puzzle.surface.slice(0, 500), '较晚返回的结果不清掉新草稿');

const invalid = await fetch(`${origin}/api/v1/solo/judge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invalid-solo-token-integration-check', question }), signal: AbortSignal.timeout(30_000) });
check(!invalid.ok, '真实服务拒绝无效单人凭证');
const rejected = errorBodySchema.parse(await invalid.json());
const failureId = randomUUID(); const failed = failSoloTurn(beginSoloTurn(game, failureId, question), failureId, rejected.error.message);
check(failed.turns.at(-1)?.status === 'failed' && failed.drafts.ask === question, '真实失败保留尝试和可重试输入');
check(!canRateSoloPuzzle(failed.answer, failed.turns), '普通提问与失败请求不开放评价');
if (session.hintsTotal > 0) {
  const hint = await call('/solo/hints', z.object({ text: z.string().min(1) }), { token: session.token, index: 0 });
  assert.ok(hint.text);
  check(Boolean(hint.text), '按序获取真实提示');
}
const revealed = await call('/solo/reveal', z.object({ answer: z.string().min(1) }), { token: session.token, confirmed: true });
check(Boolean(revealed.answer), '主动揭晓真实答案');
const solutionId = randomUUID(); const solving = beginSoloTurn({ ...game, mode: 'solve' }, solutionId, revealed.answer);
const solved = await call('/solo/solve', soloSolveResponseSchema, { token: session.token, solution: revealed.answer, useLargeModel: false });
assert.equal(solved.result, 'solved', '用真实答案还原时未判定为破解成功');
const finished = completeSoloTurn(solving, solutionId, solved);
check(finished.answer === revealed.answer && finished.turns.at(-1)?.status === 'succeeded', '真实成功还原写入汤底和回合状态');
check(canRateSoloPuzzle(finished.answer, finished.turns), '完成有效还原后开放评价');
assert.throws(() => beginSoloTurn(finished, randomUUID(), question)); check(true, '已结束的单人局拒绝继续提问');
check(savedGameSchema.safeParse(JSON.parse(JSON.stringify(finished))).success, '完成后的记录可以按正式存储结构往返');
console.log(`全部 ${checks} 项真实 AI 与单人状态检查通过；TapTap 存储和页面重进仍待真机。`);
