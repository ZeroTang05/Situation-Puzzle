/** HTTP 错误保留状态、稳定错误码和服务器等待时间，界面按结构处理。 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) { super(message); this.name = 'ApiError'; }
}
