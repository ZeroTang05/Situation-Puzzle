/**
 * 通用限流：策略装饰器 + 纯函数（窗口对齐、桶键构造、重试时间）。
 *
 * 设计取舍（docs/rebuild/16-CONCURRENCY-LIMITS.md）：
 *  - **元数据驱动**而非「按路由前缀一刀切」：每个受保护的接口显式声明规则，
 *    避免误伤正常路径。类级标注对整个控制器生效，方法级覆盖类级。
 *  - **固定窗口**：窗口起点由服务端时钟算出（见 windowStartOf），
 *    日/小时按东八区自然边界对齐，与赞助自然月算法同一时区。
 *  - **计数落在数据库**：多副本部署时上限不会被放大，进程重启也不会把限额清零。
 *  - 限流是「准入控制」不是「业务规则」：计数失败时放行，不让限流本身成为故障源。
 */
import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit_rule';

/** 计数维度：登录用户 / 客户端 IP。 */
export type RateLimitDimension = 'user' | 'ip';

export interface RateLimitRule {
  /** 作用域：桶键前缀，同时便于日志与排查 */
  scope: string;
  /** 窗口内允许的次数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSeconds: number;
  /** 计数维度 */
  keyBy: RateLimitDimension;
}

/** 标注限流规则。类级标注覆盖整个控制器，方法级优先于类级。 */
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT_KEY, rule);

/** 取生效规则：方法级优先，其次类级，都没有则不限流。 */
export function rateLimitRuleOf(handler: unknown, klass: unknown): RateLimitRule | undefined {
  const fromHandler = Reflect.getMetadata(RATE_LIMIT_KEY, handler as object) as RateLimitRule | undefined;
  if (fromHandler) return fromHandler;
  const fromClass = Reflect.getMetadata(RATE_LIMIT_KEY, klass as object) as RateLimitRule | undefined;
  return fromClass ?? undefined;
}

/** 东八区偏移（毫秒）。日/小时按自然边界对齐。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 窗口起点（毫秒时间戳）。
 *  - 86400 秒 → 东八区自然日
 *  - 3600 秒 → 东八区自然小时
 *  - 其它 → 按窗口长度对齐 epoch（分钟对齐在任何整点时区下都等于自然分钟）
 */
export function windowStartOf(nowMs: number, windowSeconds: number): number {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('限流窗口必须为正数');
  }
  if (windowSeconds === 86_400) {
    const local = nowMs + SHANGHAI_OFFSET_MS;
    return Math.floor(local / 86_400_000) * 86_400_000 - SHANGHAI_OFFSET_MS;
  }
  if (windowSeconds === 3_600) {
    const local = nowMs + SHANGHAI_OFFSET_MS;
    return Math.floor(local / 3_600_000) * 3_600_000 - SHANGHAI_OFFSET_MS;
  }
  const size = windowSeconds * 1000;
  return Math.floor(nowMs / size) * size;
}

/** 桶键：作用域 + 维度 + 主体。不同作用域互不影响。 */
export function rateLimitBucketKey(scope: string, dimension: RateLimitDimension, subject: string): string {
  return `${scope}:${dimension}:${subject}`;
}

/** 距窗口结束的秒数（至少 1 秒），用于 Retry-After 与提示文案。 */
export function retryAfterSeconds(windowStartMs: number, windowSeconds: number, nowMs: number): number {
  const end = windowStartMs + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - nowMs) / 1000));
}

/** 超限提示：把等待时间说清楚，别让用户猜。 */
export function rateLimitMessage(retryAfter: number): string {
  if (retryAfter < 60) return `操作太频繁了，请在 ${retryAfter} 秒后重试。`;
  if (retryAfter < 3600) return `操作太频繁了，请在 ${Math.ceil(retryAfter / 60)} 分钟后重试。`;
  if (retryAfter < 86_400) return `操作太频繁了，请在 ${Math.ceil(retryAfter / 3600)} 小时后重试。`;
  return `操作太频繁了，请明天再来试试。`;
}
