import { z } from 'zod';
import { judgeQuestionWithJev } from '@/lib/jev';

/** 本地题目的提问由服务端调用共用 Jev 模块，密钥不会发给浏览器。 */
const requestSchema = z.object({
  story: z.string().min(1).max(4000),
  answer: z.string().min(1).max(4000),
  question: z.string().min(1).max(500),
  language: z.enum(['zh', 'en']).default('zh'),
});

export async function POST(request: Request) {
  const input = requestSchema.parse(await request.json());
  const result = await judgeQuestionWithJev(process.env.OPENCODE_API_KEY ?? '', input.story, input.answer, input.question, undefined, input.language);
  return Response.json(result);
}
