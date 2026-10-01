/** 等待室 HTTP 接口：创建、邀请预览、加入、快照轮询、选题、离开、踢人、解散、开局。 */
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

  /** 建等待室：房主单例——已有未开局等待室返回同一实例；不写数据库。 */
  @HttpCode(HttpStatus.CREATED)
  @Post('lobbies')
  async create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(lobbyCreateRequestSchema)) body: z.infer<typeof lobbyCreateRequestSchema>,
  ) {
    return this.lobbyService.create(user, body.capacity);
  }

  @Get('lobbies/by-invite/:token')
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
    this.lobbyService.leave(user, id);
    return { ok: true };
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post('lobbies/:id/kick')
  async kick(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: { userId?: unknown }) {
    const userId = typeof body.userId === 'string' ? body.userId : '';
    if (!userId) throw new BadRequestException('userId 必填');
    this.lobbyService.kick(user, id, userId);
    return { ok: true };
  }

  /** 房主解散等待室：删除内存对象，零数据库操作。 */
  @HttpCode(HttpStatus.ACCEPTED)
  @Delete('lobbies/:id')
  async dismiss(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    this.lobbyService.dismiss(user, id);
    return { ok: true };
  }

  /** 开始本轮：唯一写库入口（授权预留 + 建房 + 建局）。 */
  @HttpCode(HttpStatus.CREATED)
  @Post('lobbies/:id/start')
  async start(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.lobbyService.start(user, id);
  }
}
