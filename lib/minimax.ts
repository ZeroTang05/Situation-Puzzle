/** 通过 Anthropic SDK 在服务端调用 MiniMax；网页与 Worker 共用。 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Language } from './jev';
import { questionPrompt } from './prompts/question';
import { solutionPrompt } from './prompts/solution';

export type MiniMaxConfig = { MINIMAX_API_KEY?: string; MINIMAX_BASE_URL?: string; MINIMAX_MODEL?: string };
const confidence = z.number().min(0).max(1);
const questionSchema = z.object({ verdict: z.enum(['Yes', 'No', 'Irrelevant', 'Uncertain']), confidence });
const solutionSchema = z.object({ outcome: z.enum(['Solved', 'Close', 'Not yet', 'Uncertain']), confidence });

/** 只解析最终文本 JSON；截断、格式错误和连接错误立即交给调用方。 */
async function requestJudgment(config: MiniMaxConfig, system: string, input: Record<string, string>): Promise<unknown> {
  if (!config.MINIMAX_API_KEY) throw new Error('缺少 MINIMAX_API_KEY');
  const client = new Anthropic({
    apiKey: config.MINIMAX_API_KEY,
    baseURL: config.MINIMAX_BASE_URL || 'https://api.minimax.cn/anthropic',
    maxRetries: 0,
    timeout: 60_000,
  });
  const message = await client.messages.create({
    model: config.MINIMAX_MODEL || 'MiniMax-M3.1-Flash',
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  });
  if (message.stop_reason !== 'end_turn') throw new Error(`MiniMax 判题未完成：${message.stop_reason}`);
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  return JSON.parse(text);
}

/** 补判问题：返回现有中英文判定值，前端继续使用相同展示逻辑。 */
export async function judgeQuestionWithMiniMax(config: MiniMaxConfig, story: string, answer: string, question: string, language: Language) {
  const result = questionSchema.parse(await requestJudgment(config, questionPrompt, { story, answer, question, language }));
  const labels = { Yes: '是', No: '否', Irrelevant: '无关', Uncertain: '无法确定' };
  return { verdict: language === 'en' ? result.verdict : labels[result.verdict], confidence: result.confidence, model: 'minimax' as const };
}

/** 最终判题：只返回判定，汤底由业务接口在成功后单独下发。 */
export async function solveWithMiniMax(config: MiniMaxConfig, story: string, answer: string, solution: string, language: Language) {
  const result = solutionSchema.parse(await requestJudgment(config, solutionPrompt, { story, answer, solution, language }));
  const labels = { Solved: '破解成功', Close: '接近真相', 'Not yet': '还没猜对', Uncertain: '无法确定' };
  return { outcome: language === 'en' ? result.outcome : labels[result.outcome], confidence: result.confidence, model: 'minimax' as const };
}
