/** Jev 调用错误：携带分类，调用方按分类决定重试与报警，不吞错误。 */
import type { JevErrorClass } from './types.js';

export class JevError extends Error {
  constructor(
    public readonly errorClass: JevErrorClass,
    message: string,
    /** 仅 rate_limited 时可能提供：上游要求等待的毫秒数 */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

/** 基础设施故障判断：协议错误与鉴权错误不算基础设施抖动，直接报警。 */
export function isInfraFailure(error: unknown): boolean {
  if (!(error instanceof JevError)) return true;
  return error.errorClass !== 'auth' && error.errorClass !== 'protocol';
}
