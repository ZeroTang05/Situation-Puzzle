/**
 * API 进程启动：express 先挂 better-auth 路由（需要原始请求体），再初始化 Nest。
 * 配置缺失、数据库不可达都在这里就地失败；进程退出码 1。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { loadEnv } from './env.js';
import { createDb } from '@jev/database';
import { createSmtpMailer } from './auth/mailer.js';
import { createAuth } from './auth/auth.types.js';
import { jevConfigFromEnv } from '@jev/jev';
import { createAppContext } from './bootstrap.js';
import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './exception.filter.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';

async function main(): Promise<void> {
  const logger = new Logger('API');
  const env = loadEnv();

  const db = createDb(env.DATABASE_URL);
  // 启动即验证数据库连通，失败就地崩溃
  await db.pool.query('select 1');

  const mailer = createSmtpMailer({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
  });

  const auth = createAuth({ env, db, mailer });
  const jev = jevConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
  const context = await createAppContext({ env, db, mailer, auth, jev });

  const nestApp = await NestFactory.create(AppModule, new ExpressAdapter(context.expressServer), {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  nestApp.setGlobalPrefix('api/v1');
  nestApp.enableCors({ origin: env.PUBLIC_BASE_URL, credentials: true });
  nestApp.useGlobalFilters(new GlobalExceptionFilter());
  nestApp.enableShutdownHooks();

  await nestApp.init();
  const gateway = new RealtimeGateway();
  const port = env.PORT;
  const httpServer = context.expressServer.listen(port, () =>
    logger.log(`API 已启动：http://localhost:${port}/api/v1/health/live`),
  );
  gateway.attach(httpServer);
  const graceful = async () => {
    await gateway.shutdown();
    await context.queue.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void graceful());
  process.on('SIGTERM', () => void graceful());
}

main().catch((error) => {
  console.error('[API] 启动失败：', error);
  process.exit(1);
});
