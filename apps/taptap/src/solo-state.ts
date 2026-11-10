/** 单人记录与判题状态：先记录发送，再按同一回合编号写回结果，失败记录保留。 */
import { z } from 'zod';
import { soloJudgeResponseSchema, soloSessionResponseSchema, soloSolveResponseSchema } from '@jev/contracts';

export const soloTurnSchema = z.object({
  id: z.uuid(), kind: z.enum(['ask', 'solve', 'hint']), text: z.string(),
  status: z.enum(['sending', 'succeeded', 'failed', 'interrupted']),
  result: z.string().optional(), confidence: z.number().min(0).max(1).optional(), error: z.string().optional(),
});
export const savedGameSchema = z.object({
  session: soloSessionResponseSchema, turns: z.array(soloTurnSchema), answer: z.string().nullable(),
  drafts: z.object({ ask: z.string(), solve: z.string() }), mode: z.enum(['ask', 'solve']),
  hintsUsed: z.number().int().nonnegative(), useLargeModel: z.boolean(),
});
export type SavedGame = z.infer<typeof savedGameSchema>;

/** 提交内容随回合一起落盘；页面切换不会清掉正在等待结果的输入。 */
export function beginSoloTurn(game: SavedGame, id: string, value: string): SavedGame {
  if (game.answer || game.turns.some((turn) => turn.status === 'sending')) throw new Error('当前单人局无法继续提交');
  const text = value.trim();
  if (!text) throw new Error('提问或还原不能为空');
  return { ...game, drafts: { ...game.drafts, [game.mode]: text }, turns: [...game.turns, { id, kind: game.mode, text, status: 'sending' }] };
}

/** 只完成目标回合；返回时新写的草稿保持原样。 */
export function completeSoloTurn(game: SavedGame, id: string, reply: unknown): SavedGame {
  const turn = game.turns.find((item) => item.id === id);
  if (!turn || turn.kind === 'hint' || turn.status !== 'sending') throw new Error('待完成的单人回合不存在');
  const result = turn.kind === 'ask' ? soloJudgeResponseSchema.parse(reply) : soloSolveResponseSchema.parse(reply);
  const answer = 'answer' in result ? result.answer : undefined;
  if (result.result === 'solved' && !answer) throw new Error('成功还原响应缺少汤底');
  return { ...game,
    turns: game.turns.map((item) => item.id === id ? { ...item, status: 'succeeded', result: result.result, confidence: result.confidence } : item),
    drafts: { ...game.drafts, [turn.kind]: game.drafts[turn.kind].trim() === turn.text ? '' : game.drafts[turn.kind] },
    mode: turn.kind === 'solve' && result.result !== 'solved' && game.mode === 'solve' ? 'ask' : game.mode,
    answer: answer ?? game.answer,
  };
}

/** 失败就保留该次尝试和输入，允许玩家核对后重新提交。 */
export function failSoloTurn(game: SavedGame, id: string, error: string): SavedGame {
  const turn = game.turns.find((item) => item.id === id);
  if (!turn || turn.status !== 'sending') throw new Error('待失败处理的单人回合不存在');
  return { ...game, turns: game.turns.map((item) => item.id === id ? { ...item, status: 'failed', error } : item) };
}

/** 新启动中没有原来的网络请求；将尚未收到结果的回合标明中断，不自动重发。 */
export function recoverInterruptedSolo(game: SavedGame): SavedGame {
  return game.turns.some((turn) => turn.status === 'sending')
    ? { ...game, turns: game.turns.map((turn) => turn.status === 'sending' ? { ...turn, status: 'interrupted' } : turn) }
    : game;
}
