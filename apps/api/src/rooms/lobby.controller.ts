/**
 * 会客厅 HTTP 接口（v3：每个用户固定一个会客厅，id 永久不变）。
 *
 * POST /lobbies             拿我的会客厅（没有就建一个）
 * POST /lobbies/:id/invite  房主生成/重置邀请 token（返回 {token, kind:'lobby'}）
 * GET  /invites/lobby/:token 预览邀请（只查 lobby_invites）
 * POST /lobbies/join        凭邀请加入
 * GET  /lobbies/:id         成员轮询快照
 * POST /lobbies/:id/select  房主选题
 * POST /lobbies/:id/leave   非房主离开
 * POST /lobbies/:id/kick    房主踢人
 * DELETE /lobbies/:id       房主解散（清座位/邀请，保留 id）
 * POST /lobbies/:id/start   开局（会客厅 → 卧室）
 */
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, HttpStatus } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { LobbyService } from './lobby.service.js';
import { lobbyCreateRequestSchema, lobbyJoinRequestSchema, lobbySelectRequestSchema } from '@jev/contracts';

@Controller()
@UseGuards(SessionGuard)
export class LobbyController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(@Inject(LobbyService) private readonly lobbyService: LobbyService) {}

  /** 拿我的会客厅：没有就建一个，host_user_id UNIQUE 保证幂等。 */
  @HttpCode(HttpStatus.OK)
  @Post('lobbies')
  async openOrGet(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(lobbyCreateRequestSchema)) body: z.infer<typeof lobbyCreateRequestSchema>,
  ) {
    const { lobbyId, existed } = await this.lobbyService.openOrGetLobby(user, body.capacity);
    return { lobbyId, existed };
  }

  /** 房主生成/重置会客厅邀请：旧邀请 revoke、新邀请 token 一次性返回。 */
  @HttpCode(HttpStatus.CREATED)
  @Post('lobbies/:id/invite')
  async createInvite(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.lobbyService.createInvite(user, id);
  }

  @Get('invites/lobby/:token')
  async preview(@CurrentUser() _user: SessionUser, @Param('token') token: string) {
    return this.lobbyService.previewByInvite(token);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('lobbies/join')
  async join(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(lobbyJoinRequestSchema)) body: z.infer<typeof lobbyJoinRequestSchema>,
  ) {
    return this.lobbyService.join(user, body.token);
  }

  /** 等待页轮询：成员、在线状态、已选题、开局去向。 */
  @Get('lobbies/:id')
  async snapshot(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.lobbyService.snapshot(user, id);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('lobbies/:id/select')
  async select(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(lobbySelectRequestSchema)) body: z.infer<typeof lobbySelectRequestSchema>,
  ) {
    await this.lobbyService.select(user, id, body.puzzleId, body.language);
    return { ok: true };
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('lobbies/:id/leave')
  async leave(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    await this.lobbyService.leave(user, id);
    return { ok: true };
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('lobbies/:id/kick')
  async kick(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: { userId?: unknown }) {
    const userId = typeof body.userId === 'string' ? body.userId : '';
    if (!userId) throw new BadRequestException('userId 必填');
    await this.lobbyService.kick(user, id, userId);
    return { ok: true };
  }

  /** 房主解散会客厅：清座位和邀请，保留 id。 */
  @HttpCode(HttpStatus.ACCEPTED)
  @Delete('lobbies/:id')
  async dismiss(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    await this.lobbyService.dismiss(user, id);
    return { ok: true };
  }

  /** 开始本轮：会客厅 → 卧室，清会客厅临时态。 */
  @HttpCode(HttpStatus.CREATED)
  @Post('lobbies/:id/start')
  async start(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.lobbyService.start(user, id);
  }
}
