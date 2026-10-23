/**
 * 私聊 HTTP 接口（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * GET  /conversations                我的会话列表
 * GET  /conversations/:id            会话详情（对方昵称）
 * GET  /conversations/:id/messages   拉消息（聊天页 3 秒轮询）
 * POST /conversations/:id/messages   发消息
 * POST /conversations/:id/read       推进已读水位
 * POST /conversations/:id/start-room 快捷开局（来一局）：建房 + 给对方发邀请卡片
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { dmReadRequestSchema, dmSendRequestSchema, quickRoomRequestSchema } from '@jev/contracts';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimit } from '../common/rate-limit.js';
import { ChatService } from './chat.service.js';

@Controller()
@UseGuards(SessionGuard)
export class ChatController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(@Inject(ChatService) private readonly chatService: ChatService) {}

  /** 会话列表：聊天页 3 秒轮询一次，限额按每分钟 60 次留一倍余量。 */
  @RateLimit({ scope: 'chat.conversations', limit: 60, windowSeconds: 60, keyBy: 'user' })
  @Get('conversations')
  async conversations(@CurrentUser() user: SessionUser) {
    return this.chatService.listConversations(user);
  }

  /** 会话详情：聊天页顶栏显示对方昵称。 */
  @RateLimit({ scope: 'chat.conversation', limit: 60, windowSeconds: 60, keyBy: 'user' })
  @Get('conversations/:id')
  async conversation(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.chatService.getConversation(user, id);
  }

  @RateLimit({ scope: 'chat.messages', limit: 120, windowSeconds: 60, keyBy: 'user' })
  @Get('conversations/:id/messages')
  async messages(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.chatService.listMessages(user, id);
  }

  @RateLimit({ scope: 'chat.send', limit: 60, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @Post('conversations/:id/messages')
  async send(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(dmSendRequestSchema)) body: z.infer<typeof dmSendRequestSchema>,
  ) {
    return this.chatService.sendMessage(user, id, body.text);
  }

  /** 推进已读水位：只前进不后退。 */
  @RateLimit({ scope: 'chat.read', limit: 120, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('conversations/:id/read')
  async read(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(dmReadRequestSchema)) body: z.infer<typeof dmReadRequestSchema>,
  ) {
    return this.chatService.markRead(user, id, body.lastReadSeq);
  }

  /** 快捷开局：建房 + 建局 + 给对方发邀请卡片（对方点了卡片才进房）。 */
  @RateLimit({ scope: 'chat.quickRoom', limit: 10, windowSeconds: 60, keyBy: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @Post('conversations/:id/start-room')
  async startRoom(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(quickRoomRequestSchema)) body: z.infer<typeof quickRoomRequestSchema>,
  ) {
    return this.chatService.startQuickRoom(user, id, body.puzzleId, body.language);
  }
}
