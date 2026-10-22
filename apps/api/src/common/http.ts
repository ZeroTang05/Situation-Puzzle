/**
 * 公共 HTTP 基础设施。
 *
 * 成功响应统一 { data, requestId }；失败统一 { error: { code, message }, requestId }
 * （docs/rebuild/03-SPEC.md §6）。requestId 用 AsyncLocalStorage 贯穿日志与响应。
 */
import {
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  type NestMiddleware,
  type PipeTransform,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ERROR_STATUS, type ErrorCode } from '@jev/contracts';
import { DomainError } from '@jev/domain';
import { type ZodType } from 'zod';

// ---------- requestId 上下文 ----------

export const requestIdContext = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId(): string {
  return requestIdContext.getStore()?.requestId ?? 'unknown';
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void): void {
    requestIdContext.run({ requestId: randomUUID() }, next);
  }
}

/** 成功响应信封 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => ({ data: data ?? null, requestId: currentRequestId() })));
  }
}

// ---------- 错误处理 ----------

/** 统一错误体：稳定 code + 面向用户的 message，不返回堆栈与内部细节。 */
export function errorBody(code: ErrorCode, message: string, params?: Record<string, unknown>) {
  return {
    error: { code, message, ...(params ? { params } : {}) },
    requestId: currentRequestId(),
  };
}

export function domainErrorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code] ?? 500;
}

// ---------- Zod 校验管道 ----------

export class ZodValidationPipe<D extends ZodType> implements PipeTransform {
  constructor(private readonly schema: D) {}

  transform(value: unknown, _metadata: ArgumentMetadata): import('zod').infer<D> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DomainError('VALIDATION_FAILED', `字段 ${issue?.path.join('.') ?? ''}：${issue?.message ?? '格式不正确'}`);
    }
    return parsed.data;
  }
}

// ---------- 当前用户 ----------

export interface SessionUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  nickname: string;
  roles: string[];
  status: 'active' | 'suspended' | 'deletion_pending';
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => {
  const request = context.switchToHttp().getRequest();
  return request.sessionUser as SessionUser;
});

// ---------- 角色守卫 ----------

export const ROLE_KEY = 'required_roles';
/** 标注所需后台角色；不标注表示仅需登录。 */
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLE_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const required: string[] | undefined =
      Reflect.getMetadata(ROLE_KEY, context.getHandler()) ?? Reflect.getMetadata(ROLE_KEY, context.getClass());
    if (!required || required.length === 0) return true;
    const request = context.switchToHttp().getRequest();
    const roles: string[] = request.sessionUser?.roles ?? [];
    if (required.some((role) => roles.includes(role))) return true;
    throw new DomainError('FORBIDDEN', '需要对应后台角色');
  }
}
