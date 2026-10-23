/**
 * 好友 HTTP 接口（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * GET    /friends                 我的好友列表
 * GET    /friends/search?email=   按邮箱精确查找站内用户（只用于加好友）
 * POST   /friends/requests        发送好友申请
 * GET    /friends/requests        好友申请列表（收到的 + 发出的）
 * POST   /friends/requests/:id/review   同意 / 拒绝
 * DELETE /friends/requests/:id    撤回自己发出的申请
 * DELETE /friends/:userId         删除好友
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import {
  friendRequestCreateRequestSchema,
  friendRequestReviewRequestSchema,
  friendSearchRequestSchema,
} from '@jev/contracts';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimit } from '../common/rate-limit.js';
import { FriendsService } from './friends.service.js';

@Controller()
@UseGuards(SessionGuard)
export class FriendsController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(@Inject(FriendsService) private readonly friendsService: FriendsService) {}

  @RateLimit({ scope: 'friends.list', limit: 60, windowSeconds: 60, keyBy: 'user' })
  @Get('friends')
  async list(@CurrentUser() user: SessionUser) {
    return this.friendsService.list(user);
  }

  /** 按邮箱精确查找：刻意不做前缀模糊搜索，避免枚举站内邮箱。 */
  @RateLimit({ scope: 'friends.search', limit: 30, windowSeconds: 60, keyBy: 'user' })
  @Get('friends/search')
  async search(
    @CurrentUser() user: SessionUser,
    @Query(new ZodValidationPipe(friendSearchRequestSchema)) query: z.infer<typeof friendSearchRequestSchema>,
  ) {
    return this.friendsService.search(user, query.email);
  }

  @RateLimit({ scope: 'friends.request.create', limit: 10, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @Post('friends/requests')
  async createRequest(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(friendRequestCreateRequestSchema)) body: z.infer<typeof friendRequestCreateRequestSchema>,
  ) {
    return this.friendsService.createRequest(user, body.email, body.message);
  }

  @RateLimit({ scope: 'friends.request.list', limit: 60, windowSeconds: 60, keyBy: 'user' })
  @Get('friends/requests')
  async listRequests(@CurrentUser() user: SessionUser) {
    return this.friendsService.listRequests(user);
  }

  /** 处理申请：同意后建立双向好友关系并建会话。 */
  @RateLimit({ scope: 'friends.request.review', limit: 30, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('friends/requests/:id/review')
  async review(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(friendRequestReviewRequestSchema)) body: z.infer<typeof friendRequestReviewRequestSchema>,
  ) {
    return this.friendsService.reviewRequest(user, id, body.accept);
  }

  /** 撤回自己发出的申请。 */
  @RateLimit({ scope: 'friends.request.cancel', limit: 30, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Delete('friends/requests/:id')
  async cancel(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    await this.friendsService.cancelRequest(user, id);
    return { ok: true };
  }

  /** 删除好友：双向两行一起删。 */
  @RateLimit({ scope: 'friends.remove', limit: 30, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Delete('friends/:userId')
  async remove(@CurrentUser() user: SessionUser, @Param('userId') friendUserId: string) {
    await this.friendsService.removeFriend(user, friendUserId);
    return { ok: true };
  }
}
