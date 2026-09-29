/**
 * HTTP 客户端：统一信封、稳定错误码、requestId 透出。
 * 单人请求 credentials: 'omit'——不携带会话（docs/rebuild/08-SOLO.md §3）。
 */
import type { ErrorCode } from '@jev/contracts';
import { displayError, type Language } from '@jev/i18n';

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode | string,
    message: string,
    public readonly params?: Record<string, unknown>,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 单人接口必须 omit */
  credentials?: 'omit' | 'include';
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)]) : AbortSignal.timeout(options.timeoutMs ?? 60_000),
    credentials: options.credentials ?? 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; params?: Record<string, unknown> } }
    | null;

  if (!response.ok || !payload || payload.error) {
    const error = payload?.error;
    throw new ApiError(error?.code ?? 'INTERNAL', error?.message ?? 'Request failed', error?.params, response.status);
  }
  return payload.data as T;
}

/**
 * 把服务端抛出的 ApiError 翻译成本地语言：code 是稳定枚举，
 * 客户端通过 @jev/i18n 的 displayError() 给出对用户友好的文案。
 * 服务端原始 message（目前为中文）只在 code 未注册或 fallback 不存在时使用。
 */
export function translateApiError(error: unknown, language: Language, fallback: string): string {
  if (error instanceof ApiError) return displayError(error.code, language, fallback);
  if (error instanceof Error) return error.message;
  return fallback;
}
