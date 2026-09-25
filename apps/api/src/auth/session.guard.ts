/**
 * 会话守卫：每次请求用 Better Auth 校验 Cookie 会话（docs/rebuild/05-OPERATIONS.md §2）。
 * 拒绝停用账号；角色从 role_assignments 读取并缓存在请求上。
 */
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { profiles, roleAssignments } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { type SessionUser } from '../common/http.js';
import { IS_ANONYMOUS_KEY, IS_PUBLIC_KEY } from '../common/public.js';

function nodeHeadersToHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }
  return headers;
}

@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlerMeta = (key: string): boolean =>
      Boolean(Reflect.getMetadata(key, context.getHandler()) ?? Reflect.getMetadata(key, context.getClass()));
    // 公开接口与单人匿名接口都不加载会话（单人请求携带 Cookie 也被忽略）
    if (handlerMeta(IS_PUBLIC_KEY)) return true;
    if (handlerMeta(IS_ANONYMOUS_KEY)) return true;

    const request = context.switchToHttp().getRequest();
    if (request.sessionUser) return true;

    const authResult = await app().auth.api.getSession({
      headers: nodeHeadersToHeaders(request.headers),
    });
    if (!authResult?.user) {
      throw new DomainError('UNAUTHORIZED', '请先登录');
    }

    const [profile] = await app().db.db.select().from(profiles).where(eq(profiles.userId, authResult.user.id)).limit(1);
    if (!profile) {
      throw new DomainError('UNAUTHORIZED', '账号档案不存在');
    }
    if (profile.status !== 'active') {
      throw new DomainError('FORBIDDEN', '账号已被停用');
    }

    const roleRows = await app().db.db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, authResult.user.id));

    const sessionUser: SessionUser = {
      userId: authResult.user.id,
      email: authResult.user.email,
      emailVerified: authResult.user.emailVerified,
      name: authResult.user.name,
      nickname: profile.nickname,
      roles: roleRows.map((r) => r.role),
      status: profile.status,
    };
    request.sessionUser = sessionUser;
    return true;
  }
}
