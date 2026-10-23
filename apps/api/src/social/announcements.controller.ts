/**
 * 站内信（群发公告）后台接口（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * POST /admin/announcements  群发：给每个 active 用户落一条通知
 * GET  /admin/announcements  站内信列表（表头可排序）
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { announcementCreateRequestSchema } from '@jev/contracts';
import { auditLogs } from '@jev/database';
import { CurrentUser, type SessionUser, RequireRoles, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimit } from '../common/rate-limit.js';
import { app } from '../context.js';
import { NotificationsService } from './notifications.service.js';

/** 后台整体限流：与其它后台接口同一档（每管理员每分钟 120 次）。 */
@RateLimit({ scope: 'admin', limit: 120, windowSeconds: 60, keyBy: 'user' })
@Controller('admin/announcements')
@UseGuards(SessionGuard)
export class AnnouncementsController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(@Inject(NotificationsService) private readonly notificationsService: NotificationsService) {}

  /** 群发站内信：发布即给每个 active 用户落一条通知。 */
  @RequireRoles('admin')
  @HttpCode(HttpStatus.CREATED)
  @Post()
  async publish(
    @CurrentUser() operator: SessionUser,
    @Body(new ZodValidationPipe(announcementCreateRequestSchema)) body: z.infer<typeof announcementCreateRequestSchema>,
  ) {
    const result = await this.notificationsService.publishAnnouncement(operator, body.title, body.body);
    // 群发是影响全站的操作，必须留痕
    await app().db.db.insert(auditLogs).values({
      operatorUserId: operator.userId,
      action: 'announcement.publish',
      objectType: 'announcement',
      objectId: result.id,
      reason: body.body,
      afterSummary: { title: body.title, recipientCount: result.recipientCount },
    });
    return result;
  }

  /** 站内信列表（表头可排序）。 */
  @RequireRoles('admin')
  @Get()
  async list(
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    const parsedPage = Number.parseInt(page ?? '', 10);
    const parsedPerPage = Number.parseInt(perPage ?? '', 10);
    const safePage = Number.isNaN(parsedPage) ? 1 : Math.max(1, parsedPage);
    const safePerPage = Number.isNaN(parsedPerPage) ? 25 : Math.min(200, Math.max(1, parsedPerPage));
    return this.notificationsService.listAnnouncements({
      page: safePage,
      perPage: safePerPage,
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    });
  }
}
