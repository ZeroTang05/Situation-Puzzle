/** 房间 HTTP 接口：建房、邀请、加入、快照、命令、事件补齐、历史、答案。 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, HttpStatus } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { freeRoomAccounts, sponsorGrants } from '@jev/database';
import { hasActiveSponsorship } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RoomsService } from './rooms.service.js';
import { CommandsService, type CommandInput } from './commands.service.js';
import {
  roomCommandRequestSchema,
  roomFollowupRequestSchema,
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

  @Get('invites/room/:token')
  async invite(@CurrentUser() _user: SessionUser, @Param('token') token: string) {
    return this.roomsService.invitePreview(token);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('rooms/join')
  async join(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(roomJoinRequestSchema)) body: z.infer<typeof roomJoinRequestSchema>) {
    return this.roomsService.joinRoom(user, body.token);
  }

  /** 老成员重入：曾加入且未被踢的成员凭房间链接直接回到房间（v2 §一.6）。 */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('rooms/:id/rejoin')
  async rejoin(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.roomsService.rejoinRoom(user, id);
  }

  /** 再来一题：房主从已归档房间创建独立新房并一键迁移合格成员（10-ROOM-LIFECYCLE-REVISION §一.2/3） */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('rooms/followup')
  async createFollowup(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(roomFollowupRequestSchema)) body: z.infer<typeof roomFollowupRequestSchema>,
  ) {
    return this.roomsService.createFollowupRoom(user, body.sourceRoomId, body.puzzleId, body.language);
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
  @Get('rooms/:id/commands/:clientRequestId')
  async commandResult(@CurrentUser() user: SessionUser, @Param('id') id: string, @Param('clientRequestId') clientRequestId: string) {
    return this.commandsService.lookup(user, id, clientRequestId);
  }

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
      payload: body.payload,
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

  /** 当前可开房额度：权威判定仍在建房事务内。 */
  @Get('rooms/entitlement-preview')
  async entitlementPreview(@CurrentUser() user: SessionUser) {
    const context = app();
    const [grants, freeRows] = await Promise.all([
      context.db.db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, user.userId)),
      context.db.db.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, user.userId)).limit(1),
    ]);
    const free = freeRows[0];
    return {
      sponsored: hasActiveSponsorship(grants, new Date()),
      freeRemaining: free ? free.total - free.consumed - free.reserved : 0,
    };
  }
}
