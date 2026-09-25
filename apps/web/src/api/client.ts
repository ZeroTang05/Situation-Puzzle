/**
 * HTTP 客户端：统一信封、稳定错误码、requestId 透出。
 * 单人请求 credentials: 'omit'——不携带会话（docs/rebuild/08-SOLO.md §3）。
 */
import type { ErrorCode } from '@jev/contracts';

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
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: options.credentials ?? 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; params?: Record<string, unknown> } }
    | null;

  if (!response.ok || !payload || payload.error) {
    const error = payload?.error;
    throw new ApiError(error?.code ?? 'INTERNAL', error?.message ?? '请求失败', error?.params, response.status);
  }
  return payload.data as T;
}
