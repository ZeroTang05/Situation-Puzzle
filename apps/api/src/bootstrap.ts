/**
 * 启动装配：pg-boss 队列、express 服务器（better-auth 路由 + JSON 解析）。
 * express 装配顺序至关重要：
 *   better-auth（需要原始请求体）→ JSON 解析 → 支付回调原始体 → Nest 路由
 */
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import PgBoss from 'pg-boss';
import type { PoolClient } from 'pg';
import type { Env } from './env.js';
import type { DbHandle } from '@jev/database';
import type { Mailer } from './auth/mailer.js';
import type { BetterAuthInstance } from './auth/auth.types.js';
import type { JevConfig } from '@jev/jev';
import { type AppContext, type QueueHandle, setAppContext } from './context.js';

export interface BootstrapInput {
  env: Env;
  db: DbHandle;
  mailer: Mailer;
  auth: BetterAuthInstance;
  jev: JevConfig;
}

/** drizzle 事务类型不公开 session，运行时校验提取底层 pg client；驱动不匹配就地报错。 */
function poolClientOf(tx: unknown): PoolClient {
  const client = (tx as { session?: { client?: unknown } }).session?.client;
  if (!client || typeof (client as PoolClient).query !== 'function') {
    throw new Error('pg-boss 事务适配无法取得底层 pg client：请核对 drizzle 驱动为 node-postgres');
  }
  return client as PoolClient;
}

/** pg-boss 事务适配：把 executeSql 桥接到事务内的 pg client。 */
function txDb(client: PoolClient): { executeSql: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> } {
  return {
    executeSql: async (text, values) => {
      const result = await client.query(text, values as never[]);
      return { rows: result.rows as unknown[] };
    },
  };
}

export async function createAppContext(input: BootstrapInput): Promise<AppContext> {
  const boss = new PgBoss({ connectionString: input.env.DATABASE_URL });
  boss.on('error', (error) => console.error('[pg-boss]', error));
  await boss.start();

  const queue: QueueHandle = {
    async sendJob(name, data, options) {
      return boss.send(name, data as never, options?.delaySeconds ? { startAfter: options.delaySeconds } : {});
    },
    async sendInTx(tx, name, data) {
      // 命令、事件、任务写入共享同一事务（docs/rebuild/03-SPEC.md §7）
      return boss.send(name, data as never, { db: txDb(poolClientOf(tx)) } as never);
    },
    async close() {
      await boss.stop();
    },
  };

  const server = express();
  server.disable('x-powered-by');
  // better-auth 处理 /api/v1/auth/*：必须拿到未经 JSON 解析的原始流
  server.use('/api/v1/auth', toNodeHandler(input.auth.handler));
  server.use(express.json({ limit: '256kb' }));
  // 支付回调需要原始请求体验签
  server.use('/api/v1/payments', express.raw({ type: '*/*', limit: '256kb' }));

  const context: AppContext = {
    env: input.env,
    db: input.db,
    mailer: input.mailer,
    auth: input.auth,
    jev: input.jev,
    boss,
    queue,
    expressServer: server,
  };
  setAppContext(context);
  return context;
}
