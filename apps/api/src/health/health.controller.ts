/** 健康检查：进程存活与数据库/队列就绪（docs/rebuild/03-SPEC.md §6）。 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.js';
import { app } from '../context.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get('live')
  live(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{ ok: true }> {
    await app().db.pool.query('select 1');
    return { ok: true };
  }
}
