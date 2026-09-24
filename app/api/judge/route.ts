import { experimental_evaluate as evaluate } from 'ai';
import { z } from 'zod';

/** Jev 只做有界判断；题目和提问均由此处送往服务端，浏览器永远拿不到 Gateway 密钥。 */
const requestSchema = z.object({
  story: z.string().min(1).max(4000),
  answer: z.string().min(1).max(4000),
  question: z.string().min(1).max(500),
});

const MIN_CONFIDENCE = 0.4;

export async function POST(request: Request) {
  const input = requestSchema.parse(await request.json());
  const result = await evaluate({
    model: 'typesafe-ai/jev',
    state: { 汤面: input.story, 真相: input.answer, 玩家提问: input.question },
    questions: {
      verdict: {
        type: 'choice',
        instructions: '根据真相判断玩家提问。只能选：是、否、无关。信息不足时选择无关。',
        criteria: {
          是: '提问的事实或合理推论被真相支持。',
          否: '提问的事实或合理推论被真相否定。',
          无关: '提问和破解真相没有实质关系，或真相不能支持判断。',
        },
      },
    },
    providerOptions: { gateway: { tags: ['feature:turtle-soup-judge'] } },
  });

  const answer = result.answers.verdict;
  if (answer.type !== 'choice') throw new Error('Jev 返回了不符合预期的判断类型');
  // AI SDK 把 Jev 的 choice 概率映射为 probabilities；最大概率就是本次选择的置信度。
  const confidence = answer.probabilities?.[answer.choice] ?? 0;
  const verdict = confidence >= MIN_CONFIDENCE ? answer.choice : '无法确定';
  return Response.json({ verdict, confidence, threshold: MIN_CONFIDENCE });
}
