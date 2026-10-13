/** Anthropic SDK 的 MiniMax 适配：校验最终 JSON，记录真实模型与用量。 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { JevError } from './errors.js';
import type { AskInput, SolveInput } from './prompts.js';
import type { JevJudgeResult } from './client.js';
import type { AskVerdict, SolveVerdict, JevAttemptRecord, MiniMaxConfig } from './types.js';
import { MINIMAX_PROMPT_VERSION } from './types.js';
import { questionPrompt } from './prompts/minimax-question.js';
import { solutionPrompt } from './prompts/minimax-solution.js';

const askSchema = z.object({ result: z.enum(['yes', 'no', 'irrelevant', 'uncertain']), confidence: z.number().min(0).max(1) });
const solveSchema = z.object({ result: z.enum(['solved', 'close', 'not_yet', 'uncertain']), confidence: z.number().min(0).max(1) });

/** SDK 错误沿用现有错误分类，让单人接口与多人任务统一处理失败。 */
function classify(error: unknown): JevError {
  if (error instanceof JevError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new JevError('timeout', 'MiniMax 请求超时');
  if (error instanceof Anthropic.APIConnectionError) return new JevError('network', 'MiniMax 网络连接失败');
  if (error instanceof Anthropic.APIError) {
    if (error.status === 401 || error.status === 403) return new JevError('auth', `MiniMax 鉴权失败：${error.status}`);
    if (error.status === 429) return new JevError('rate_limited', 'MiniMax 触发限流');
    return new JevError(error.status && error.status >= 500 ? 'upstream' : 'protocol', `MiniMax 请求失败：${error.status}`);
  }
  return new JevError('protocol', 'MiniMax 返回的判题结果无效');
}

export class MiniMaxClient {
  constructor(private readonly config: MiniMaxConfig, private readonly onAttempt?: (record: JevAttemptRecord) => void) {}

  ask(input: AskInput, timeoutMs: number): Promise<JevJudgeResult<AskVerdict>> {
    return this.request('ask', input, questionPrompt, askSchema, timeoutMs);
  }

  solve(input: SolveInput, timeoutMs: number): Promise<JevJudgeResult<SolveVerdict>> {
    return this.request('solve', input, solutionPrompt, solveSchema, timeoutMs);
  }

  /** 一次调用纳入业务总期限；拒绝截断响应，错误立即交给上层。 */
  private async request<T extends AskVerdict | SolveVerdict>(purpose: 'ask' | 'solve', input: AskInput | SolveInput, system: string, schema: z.ZodType<{ result: T; confidence: number }>, timeoutMs: number): Promise<JevJudgeResult<T>> {
    if (!this.config.apiKey) throw new JevError('auth', '缺少 MINIMAX_API_KEY');
    if (timeoutMs <= 0) throw new JevError('timeout', '判题总执行期限已过');
    const startedAt = Date.now();
    const base = { purpose, attempt: 1, model: this.config.model, promptVersion: MINIMAX_PROMPT_VERSION };
    try {
      const client = new Anthropic({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, maxRetries: 0, timeout: timeoutMs });
      const message = await client.messages.create({ model: this.config.model, max_tokens: 4096, system, messages: [{ role: 'user', content: JSON.stringify(input) }] });
      if (message.stop_reason !== 'end_turn') throw new JevError('protocol', `MiniMax 判题未完成：${message.stop_reason}`);
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      const result = schema.parse(JSON.parse(text));
      this.onAttempt?.({ ...base, status: 'ok', choice: result.result, confidence: result.confidence, usage: { ...message.usage }, durationMs: Date.now() - startedAt });
      return { ...result, threshold: 0 };
    } catch (error) {
      const failure = classify(error);
      this.onAttempt?.({ ...base, status: 'failed', errorClass: failure.errorClass, durationMs: Date.now() - startedAt });
      console.error(`[minimax] ${purpose} 判题失败`, failure);
      throw failure;
    }
  }
}
