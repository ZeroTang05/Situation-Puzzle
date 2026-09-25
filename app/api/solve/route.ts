import { z } from 'zod';
import { solveWithJev } from '@/lib/jev';

const inputSchema = z.object({ story: z.string().min(1), answer: z.string().min(1), solution: z.string().min(1).max(1500), language: z.enum(['zh', 'en']).default('zh') });
/** 本地题目的结局判断与正式 Worker 共用 Jev 模块。 */
export async function POST(request: Request) {
  const input = inputSchema.parse(await request.json());
  const result = await solveWithJev(process.env.OPENCODE_API_KEY ?? '', input.story, input.answer, input.solution, undefined, input.language);
  // 只有破解成功时才随判定结果公布汤底。
  return Response.json({ ...result, ...(result.outcome === '破解成功' || result.outcome === 'Solved' ? { answer: input.answer } : {}) });
}
