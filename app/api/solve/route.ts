import { experimental_evaluate as evaluate } from 'ai';
import { z } from 'zod';

const inputSchema = z.object({ story: z.string().min(1), answer: z.string().min(1), solution: z.string().min(1).max(1500) });
const threshold = 0.4;

/** 本地网页开发时的结局判断；正式发布由 Cloudflare Worker 的同名能力执行。 */
export async function POST(request: Request) {
  const input = inputSchema.parse(await request.json());
  const result = await evaluate({ model: 'typesafe-ai/jev', state: { 汤面: input.story, 汤底: input.answer, 玩家还原: input.solution }, questions: { outcome: { type: 'choice', instructions: '判断玩家是否还原汤底的核心事件、关键原因和因果链。不要求逐字一致。', criteria: { 破解成功: '覆盖了核心事件、关键原因与因果关系。', 接近真相: '主要方向正确，但遗漏关键原因或因果环节。', 还没猜对: '与汤底核心事实不一致。' } } } });
  const answer = result.answers.outcome; if (answer.type !== 'choice') throw new Error('Jev 返回了不符合预期的判断类型');
  const confidence = answer.probabilities?.[answer.choice] ?? 0;
  return Response.json({ outcome: confidence >= threshold ? answer.choice : '无法确定', confidence, threshold });
}
