/** 实时票据：当前会话换取 30 秒一次性票据，票据不放 URL。 */
import { Controller, Post } from '@nestjs/common';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { UseGuards } from '@nestjs/common';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { realtimeTicketResponseSchema } from '@jev/contracts';
import { z } from 'zod';

/** 已使用票据：首发单 API 进程，内存记录即可；多副本部署时换 DB/Redis 存储。 */
const usedJti = new Set<string>();

@Controller('realtime')
@UseGuards(SessionGuard)
export class RealtimeController {
  @Post('tickets')
  async ticket(@CurrentUser() user: SessionUser): Promise<z.infer<typeof realtimeTicketResponseSchema>> {
    const jti = randomUUID();
    const secret = new TextEncoder().encode(app().env.REALTIME_TICKET_SECRET ?? app().env.AUTH_SECRET + ':rt');
    const ticket = await new SignJWT({ purpose: 'realtime', jti })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.userId)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(secret);

    // 清理过期记录，防止集合无限增长
    if (usedJti.size > 10_000) usedJti.clear();

    return { ticket, expiresInSeconds: 30 };
  }
}

/** 票据核销：网关调用；已用票据立即拒绝。 */
export function consumeJti(jti: string): boolean {
  if (usedJti.has(jti)) return false;
  usedJti.add(jti);
  return true;
}

void ZodValidationPipe;
