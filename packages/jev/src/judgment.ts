/** 统一判题编排：低置信度补判和主动大模型判题共用原有执行期限。 */
import { JevClient } from './client.js';
import { MiniMaxClient } from './minimax.js';
import { JevError } from './errors.js';
import type { AskInput, SolveInput, ReviewInput } from './prompts.js';
import type { JevConfig, JevAttemptRecord, Language } from './types.js';

export class JudgmentClient {
  private readonly jev: JevClient;
  constructor(private readonly config: JevConfig, private readonly onAttempt?: (record: JevAttemptRecord) => void) {
    // 默认总期限 45 秒，Jev 最多占用 25 秒，为补判保留 20 秒。
    this.jev = new JevClient({ ...config, totalDeadlineMs: Math.min(config.totalDeadlineMs, 25_000) }, onAttempt);
  }

  /** 语言由调用方现场给出（题目/本局/投稿的语言）。 */
  async ask(input: AskInput, language: Language) {
    const deadline = Date.now() + this.config.totalDeadlineMs;
    const result = await this.jev.ask(input, language);
    return result.confidence < this.config.threshold ? this.mini().ask(input, deadline - Date.now()) : result;
  }

  async solve(input: SolveInput, language: Language, useLargeModel = false) {
    const deadline = Date.now() + this.config.totalDeadlineMs;
    if (useLargeModel) return this.mini().solve(input, this.config.totalDeadlineMs);
    const result = await this.jev.solve(input, language);
    return result.confidence < this.config.threshold ? this.mini().solve(input, deadline - Date.now()) : result;
  }

  review(input: ReviewInput, language: Language) {
    return new JevClient(this.config, this.onAttempt).review(input, language);
  }

  private mini(): MiniMaxClient {
    if (!this.config.minimax) throw new JevError('auth', '缺少 MiniMax 配置');
    return new MiniMaxClient(this.config.minimax, this.onAttempt);
  }
}
