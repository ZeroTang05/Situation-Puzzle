/**
 * Jev SystemOne 客户端。
 *
 * 请求语义沿用旧 lib/jev.ts：一次请求带 state 与带选项的问题，返回选项+概率。
 * 按房间协议（docs/rebuild/04-ROOM-JEV.md §7）补齐：
 *  - 单次尝试超时 20s、最多额外重试 1 次、总执行期限 45s
 *  - 错误分类：网络/上游可重试一次，429 尊重 Retry-After，鉴权错误立即失败
 *  - 响应缺概率是协议错误，禁止默认为 0；低置信度返回 uncertain（有效判定）
 */
import { z } from 'zod';
import { JevError } from './errors.js';
import type { AskVerdict, JevAttemptRecord, JevConfig, JevPurpose, SolveVerdict, ReviewVerdict } from './types.js';
import {
  type AskInput,
  type ReviewInput,
  type SolveInput,
  askQuestion,
  askState,
  reviewQuestion,
  reviewState,
  solveQuestion,
  solveState,
  type ChoiceQuestion,
} from './prompts.js';

const answerSchema = z.object({
  answers: z
    .record(
      z.string(),
      z.object({
        choice: z.string(),
        probabilities: z.record(z.string(), z.number()),
      }),
    )
    .optional(),
});

const SYSTEMONE_QUESTION = { ask: 'verdict', solve: 'outcome', review: 'review' } as const;

/** 模型原始选项 → 稳定枚举 */
const ASK_CHOICES: Record<string, AskVerdict> = {
  是: 'yes',
  否: 'no',
  无关: 'irrelevant',
  Yes: 'yes',
  No: 'no',
  Irrelevant: 'irrelevant',
};

const SOLVE_CHOICES: Record<string, SolveVerdict> = {
  破解成功: 'solved',
  接近真相: 'close',
  还没猜对: 'not_yet',
  Solved: 'solved',
  Close: 'close',
  'Not yet': 'not_yet',
};

const REVIEW_CHOICES: Record<string, ReviewVerdict> = {
  通过: 'review_pass',
  不通过: 'review_reject',
  Approved: 'review_pass',
  Rejected: 'review_reject',
};

export interface JevJudgeResult<T extends string> {
  result: T;
  confidence: number;
  threshold: number;
}

export class JevClient {
  constructor(
    private readonly config: JevConfig,
    /** 每次真实尝试后回调：多人用于写 jev_calls，单人仅聚合计数 */
    private readonly onAttempt?: (record: JevAttemptRecord) => void,
  ) {}

  async ask(input: AskInput): Promise<JevJudgeResult<AskVerdict>> {
    return this.judge(ASK_CHOICES, 'uncertain' as AskVerdict, 'ask', askState(input, this.config.language), askQuestion(this.config.language), input.question);
  }

  async solve(input: SolveInput): Promise<JevJudgeResult<SolveVerdict>> {
    return this.judge(SOLVE_CHOICES, 'uncertain' as SolveVerdict, 'solve', solveState(input, this.config.language), solveQuestion(this.config.language), input.solution);
  }

  /** 投稿辅助审核：通过/不通过/不确定；不能忽略置信度。 */
  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const result = await this.judge(REVIEW_CHOICES, 'review_uncertain' as ReviewVerdict, 'review', reviewState(input, this.config.language), reviewQuestion(this.config.language), '');
    return result.result;
  }

  private async judge<T extends string>(
    choiceMap: Record<string, T>,
    uncertain: T,
    purpose: JevPurpose,
    state: Record<string, unknown>,
    question: ChoiceQuestion,
    playerText: string,
  ): Promise<JevJudgeResult<T>> {
    if (!this.config.apiKey) throw new JevError('auth', '缺少 Jev API 密钥');
    if (!playerText && purpose !== 'review') throw new JevError('protocol', '玩家文本为空');

    const questionName = SYSTEMONE_QUESTION[purpose];
    const deadline = Date.now() + this.config.totalDeadlineMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 500) {
        if (lastError) throw lastError;
        throw new JevError('timeout', 'Jev 总执行期限已过');
      }
      try {
        const { choice, confidence, usage } = await this.requestChoice(
          state,
          questionName,
          question,
          Math.min(this.config.attemptTimeoutMs, remaining),
        );
        this.onAttempt?.(
          this.record(purpose, attempt, 'ok', {
            choice,
            confidence,
            ...(usage !== undefined ? { usage } : {}),
          }),
        );
        const mapped = choiceMap[choice];
        if (!mapped) {
          // 响应已在 requestChoice 内校验过合法选项，这里是不变量防御
          throw new JevError('protocol', `未知选项映射：${choice}`);
        }
        return {
          result: confidence >= this.config.threshold ? mapped : uncertain,
          confidence,
          threshold: this.config.threshold,
        };
      } catch (error) {
        lastError = error;
        this.onAttempt?.(
          this.record(purpose, attempt, 'failed', {
            error,
            duration: 0,
            choice: '',
            confidence: 0,
          }),
        );
        // 只对可重试分类再试一次：429 尊重 Retry-After，其余退避 300ms×次数
        const retryable =
          error instanceof JevError &&
          (error.errorClass === 'network' ||
            error.errorClass === 'upstream' ||
            error.errorClass === 'timeout' ||
            error.errorClass === 'rate_limited');
        if (!retryable || attempt >= 2) throw error;
        if (error instanceof JevError && error.errorClass === 'rate_limited' && error.retryAfterMs) {
          const wait = Math.min(error.retryAfterMs, deadline - Date.now());
          if (wait > 0) await sleep(wait);
        } else {
          await sleep(300 * attempt);
        }
      }
    }
    throw lastError ?? new JevError('network', 'Jev 调用失败');
  }

  private record(
    purpose: JevPurpose,
    attempt: number,
    status: 'ok' | 'failed',
    extras: { choice: string; confidence: number; usage?: Record<string, unknown>; error?: unknown; duration?: number },
  ): JevAttemptRecord {
    const error = extras.error;
    const errorDuration = error instanceof JevError ? (error as JevError & { durationMs?: number }).durationMs : undefined;
    return {
      purpose,
      attempt,
      status,
      choice: extras.choice,
      confidence: extras.confidence,
      ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
      errorClass: error === undefined ? 'network' : error instanceof JevError ? error.errorClass : 'network',
      durationMs: errorDuration ?? extras.duration ?? 0,
      model: this.config.model,
      promptVersion: this.config.promptVersion,
    };
  }

  /** 单次模型请求：核对返回选项与概率，缺概率视为协议错误。 */
  private async requestChoice(
    state: Record<string, unknown>,
    questionName: string,
    question: ChoiceQuestion,
    timeoutMs: number,
  ): Promise<{ choice: string; confidence: number; usage?: Record<string, unknown> | undefined }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          state,
          questions: { [questionName]: question },
        }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new JevError('auth', `Jev 鉴权失败：${response.status}`);
      }
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        throw new JevError('rate_limited', 'Jev 触发限流：429', Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined);
      }
      if (!response.ok) {
        throw new JevError('upstream', `Jev 请求失败：${response.status}`);
      }

      const parsed = answerSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new JevError('protocol', 'Jev 返回结构不合法');
      }
      const answer = parsed.data.answers?.[questionName];
      if (!answer?.choice || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new JevError('protocol', `Jev 返回无效选项：${answer?.choice ?? '空'}`);
      }
      // 缺概率是协议错误，不默认为 0
      const confidence = answer.probabilities?.[answer.choice];
      if (confidence === undefined || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new JevError('protocol', `Jev 返回无效置信度：${String(confidence)}`);
      }
      return { choice: answer.choice, confidence };
    } catch (error) {
      if (error instanceof JevError) {
        (error as JevError & { durationMs?: number }).durationMs = Date.now() - startedAt;
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new JevError('timeout', 'Jev 请求超时');
      }
      throw new JevError('network', `Jev 网络错误：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
