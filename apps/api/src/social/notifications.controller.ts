/**
 * 通知 HTTP 接口（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * GET  /notifications              通知列表（最新在前）
 * GET  /notifications/unread-count 未读计数（铃铛角标，10 秒轮询一次）
 * POST /notifications/read         标记已读（给 id 列表或全部已读）
 */
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { notificationReadRequestSchema } from '@jev/contracts';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimit } from '../common/rate-limit.js';
import { languageOf } from '../common/language.js';
import { NotificationsService } from './notifications.service.js';

/** 通知列表单页上限（与契约 NOTIFICATION_PAGE_LIMIT 一致）。 */
const PAGE_LIMIT = 50;

@Controller()
@UseGuards(SessionGuard)
export class NotificationsController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(@Inject(NotificationsService) private readonly notificationsService: NotificationsService) {}

  /** 通知列表：标题按阅读者当前语言即时拼装（语言不落库）。 */
  @RateLimit({ scope: 'notifications.list', limit: 60, windowSeconds: 60, keyBy: 'user' })
  @Get('notifications')
  async list(
    @CurrentUser() user: SessionUser,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number.parseInt(limit ?? '', 10);
    const safeLimit = Number.isNaN(parsed) ? PAGE_LIMIT : Math.min(PAGE_LIMIT, Math.max(1, parsed));
    return this.notificationsService.list(user, languageOf(headers), safeLimit);
  }

  /** 未读计数：铃铛角标，10 秒轮询一次。 */
  @RateLimit({ scope: 'notifications.unread', limit: 120, windowSeconds: 60, keyBy: 'user' })
  @Get('notifications/unread-count')
  async unread(@CurrentUser() user: SessionUser) {
    return this.notificationsService.unreadCount(user);
  }

  @RateLimit({ scope: 'notifications.read', limit: 120, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('notifications/read')
  async read(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(notificationReadRequestSchema)) body: z.infer<typeof notificationReadRequestSchema>,
  ) {
    return this.notificationsService.markRead(user, {
      ...(body.ids !== undefined ? { ids: body.ids } : {}),
      ...(body.all !== undefined ? { all: body.all } : {}),
    });
  }
}
