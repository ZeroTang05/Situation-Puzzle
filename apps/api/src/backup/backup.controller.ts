/**
 * 备份管理接口：后台的备份 / 还原 / 删除 / 下载。
 *
 * 全部经角色守卫与后台限流；写操作留审计。
 * 还原是不可逆操作：请求体必须带固定确认口令 RESTORE。
 */
import { Body, Controller, Delete, Get, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  backupCreateRequestSchema,
  backupDeleteRequestSchema,
  backupRestoreRequestSchema,
} from '@jev/contracts';
import { DomainError } from '@jev/domain';
import { CurrentUser, type SessionUser, RequireRoles, ZodValidationPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { SessionGuard } from '../auth/session.guard.js';
import { BackupService } from './backup.service.js';

/**
 * 管理后台整体限流：每个管理员每分钟 120 次（与后台其它接口同款）。
 */
@RateLimit({ scope: 'admin', limit: 120, windowSeconds: 60, keyBy: 'user' })
@Controller('admin/backups')
@UseGuards(SessionGuard)
@RequireRoles('admin')
export class BackupController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(@Inject(BackupService) private readonly backupService: BackupService) {}

  /** 备份列表 + 对象存储接入状态。 */
  @Get()
  async list() {
    return this.backupService.list();
  }

  /** 创建备份。 */
  @Post()
  async create(
    @CurrentUser() operator: SessionUser,
    @Body(new ZodValidationPipe(backupCreateRequestSchema)) body: z.infer<typeof backupCreateRequestSchema>,
  ) {
    return this.backupService.create(operator.userId, body.reason);
  }

  /** 从对象存储还原数据库：覆盖当前全部业务数据，需固定确认口令。 */
  @Post('restore')
  async restore(
    @CurrentUser() operator: SessionUser,
    @Body(new ZodValidationPipe(backupRestoreRequestSchema)) body: z.infer<typeof backupRestoreRequestSchema>,
  ) {
    return this.backupService.restore(operator.userId, body.key, body.reason);
  }

  /** 删除备份文件：key 走请求体（key 里带 `/`，不走路径参数）。 */
  @Delete()
  async remove(
    @CurrentUser() operator: SessionUser,
    @Body(new ZodValidationPipe(backupDeleteRequestSchema)) body: z.infer<typeof backupDeleteRequestSchema>,
  ) {
    await this.backupService.remove(operator.userId, body.key, body.reason);
    return { ok: true };
  }

  /** 下载备份文件本体。 */
  @Get('download')
  async download(@Query('key') key: string | undefined, @Res() res: Response): Promise<void> {
    if (!key) throw new DomainError('VALIDATION_FAILED', '缺少备份 key');
    const body = await this.backupService.download(key);
    const filename = safeFileName(key.split('/').pop() ?? 'backup.json.gz');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  }
}

/** 下载文件名：只留安全字符，避免 header 注入。 */
function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
