/**
 * Jev 适配层的共享类型：稳定枚举、配置、调用记录。
 *
 * 稳定枚举是跨端契约：中文/英文文案只在展示层映射，服务端与客户端只传枚举。
 */

/** 提问判定结果 */
export type AskVerdict = 'yes' | 'no' | 'irrelevant' | 'uncertain';

/** 还原判定结果 */
export type SolveVerdict = 'solved' | 'close' | 'not_yet' | 'uncertain';

/** 投稿辅助审核结果 */
export type ReviewVerdict = 'review_pass' | 'review_reject' | 'review_uncertain';

export type JevPurpose = 'ask' | 'solve' | 'review';

export type Language = 'zh' | 'en';

/** 判题配置：每局开局固定一个版本，配置变更不改变进行中的局。 */
export interface JevConfig {
  readonly apiKey: string;
  /** SystemOne 接口地址 */
  readonly baseUrl: string;
  readonly model: string;
  /** 置信度阈值：低于它统一返回 uncertain */
  readonly threshold: number;
  /** 提示词版本号：提示词调整必须换版本并先跑评测 */
  readonly promptVersion: string;
  /** 单次尝试超时（毫秒） */
  readonly attemptTimeoutMs: number;
  /** 总执行期限（毫秒），含一次重试 */
  readonly totalDeadlineMs: number;
  /** 语言 */
  readonly language: Language;
}

/** 判题配置版本号：进入 rounds.jevConfigVersion，用于一致性核对。 */
export function jevConfigVersion(config: JevConfig): string {
  return `${config.model}@${config.promptVersion}@t${config.threshold}@${config.language}`;
}

/** 单次真实尝试的记录：多人写入 jev_calls，单人仅匿名汇总。 */
export interface JevAttemptRecord {
  readonly purpose: JevPurpose;
  readonly attempt: number;
  readonly status: 'ok' | 'failed';
  readonly choice?: string;
  readonly confidence?: number;
  readonly usage?: Record<string, unknown>;
  readonly errorClass?: JevErrorClass;
  readonly durationMs: number;
  readonly model: string;
  readonly promptVersion: string;
}

/** 错误分类（docs/rebuild/04-ROOM-JEV.md §7）：决定是否重试、是否报警。 */
export type JevErrorClass =
  | 'network' // 网络中断、连接失败：期限内可重试一次
  | 'upstream' // 上游 5xx：期限内可重试一次
  | 'rate_limited' // 429：尊重 Retry-After，超期限则失败
  | 'auth' // 401/403：立即失败、报警，不重复尝试
  | 'protocol' // 响应结构/选项/概率不合法：明确协议错误，禁止编造结果
  | 'timeout'; // 本地超时：按剩余期限决定是否重试
