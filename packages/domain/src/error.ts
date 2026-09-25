/** 领域错误：携带稳定错误码，服务端直接映射 HTTP 响应。 */
import type { ErrorCode } from '@jev/contracts';

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly params?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
