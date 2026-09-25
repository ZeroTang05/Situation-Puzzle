/** 房间 HTTP 接口：建房、邀请、加入、快照、命令、事件补齐、历史、答案。 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, HttpStatus } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { freeRoomAccounts, roomEntitlements, sponsorGrants } from '@jev/database';
import { hasActiveSponsorship } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RoomsService } from './rooms.service.js';
import { CommandsService, type CommandInput } from './commands.service.js';
import {
  roomCommandRequestSchema,
  roomCreateRequestSchema,
  roomJoinRequestSchema,
} from '@jev/contracts';
import { z } from 'zod';

@Controller()
@UseGuards(SessionGuard)
export class RoomsController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(
    @Inject(RoomsService) private readonly roomsService: RoomsService,
    @Inject(CommandsService) private readonly commandsService: CommandsService,
  ) {}

  /** 创建等待室：记录授权（赞助或预留免费次数），尚不正式消费。 */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('rooms')
  async create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(roomCreateRequestSchema)) body: z.infer<typeof roomCreateRequestSchema>,
  ) {
    return this.roomsService.createRoom(user, body.capacity);
  }

  @Get('invites/:token')
  async invite(@CurrentUser() _user: SessionUser, @Param('token') token: string) {
    return this.roomsService.invitePreview(token);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('rooms/join')
  async join(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(roomJoinRequestSchema)) body: z.infer<typeof roomJoinRequestSchema>) {
    return this.roomsService.joinRoom(user, body.token);
  }

  @Get('rooms/:id/snapshot')
  async snapshot(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.roomsService.snapshot(user, id);
  }

  @Get('rooms/:id/events')
  async events(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('afterSeq') afterSeq: string,
  ) {
    const seq = Number(afterSeq ?? '0');
    if (!Number.isInteger(seq) || seq < 0) {
      return this.roomsService.eventsAfter(user, id, 0);
    }
    return this.roomsService.eventsAfter(user, id, seq);
  }

  /** 房间命令：服务端逐项检查身份、局、状态和队列容量。 */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('rooms/:id/commands')
  async command(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(roomCommandRequestSchema)) body: z.infer<typeof roomCommandRequestSchema>,
  ) {
    const input: CommandInput = {
      clientRequestId: body.clientRequestId,
      type: body.type,
      ...(body.roundId !== undefined ? { roundId: body.roundId } : {}),
      ...(body.expectedControlVersion !== undefined ? { expectedControlVersion: body.expectedControlVersion } : {}),
      payload: (body.payload ?? {}) as Record<string, unknown>,
    };
    return this.commandsService.handle(user, id, input);
  }

  @Get('rounds/:id/history')
  async history(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsed = cursor ? Number(cursor) : null;
    return this.roomsService.roundHistory(user, id, parsed && Number.isInteger(parsed) ? parsed : null);
  }

  @Get('rounds/:id/answer')
  async answer(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.roomsService.roundAnswer(user, id);
  }

  /** 当前可开房状态：供「开房间」按钮预判（权威判定仍在建房事务内）。 */
  @Get('rooms/entitlement-preview')
  async entitlementPreview(@CurrentUser() user: SessionUser) {
    const context = app();
    const [grants, freeRows, openRoom] = await Promise.all([
      context.db.db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, user.userId)),
      context.db.db.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, user.userId)).limit(1),
      context.db.db
        .select({ id: roomEntitlements.roomId })
        .from(roomEntitlements)
        .where(and(eq(roomEntitlements.creatorUserId, user.userId), eq(roomEntitlements.status, 'reserved')))
        .limit(1),
    ]);
    const free = freeRows[0];
    return {
      sponsored: hasActiveSponsorship(grants, new Date()),
      freeRemaining: free ? free.total - free.consumed - free.reserved : 0,
      openRoomId: openRoom[0]?.id ?? null,
    };
  }
}
