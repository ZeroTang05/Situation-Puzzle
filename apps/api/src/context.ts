/**
 * 应用上下文：main.ts 在 Nest 初始化前创建（better-auth 需要先挂到 express 路由），
 * 以模块级单例供守卫与服务读取。配置缺失在这里就地抛错，进程拒绝启动。
 */
import type PgBoss from 'pg-boss';
import type { Env } from './env.js';
import type { DbHandle } from '@jev/database';
import type { Mailer } from './auth/mailer.js';
import type { JevConfig } from '@jev/jev';
import type { BetterAuthInstance } from './auth/auth.types.js';

export interface QueueHandle {
  /** 事务外投递：延迟任务、巡检任务使用 */
  sendJob: (name: string, data: unknown, options?: { delaySeconds?: number }) => Promise<string | null>;
  /** 事务内投递：传入 drizzle 事务对象，内部提取底层 pg client（命令与任务同事务提交） */
  sendInTx: (tx: unknown, name: string, data: unknown) => Promise<string | null>;
  close: () => Promise<void>;
}

export interface AppContext {
  env: Env;
  db: DbHandle;
  mailer: Mailer;
  auth: BetterAuthInstance;
  jev: JevConfig;
  boss: PgBoss;
  queue: QueueHandle;
  expressServer: import('express').Express;
}

let context: AppContext | null = null;

export function setAppContext(value: AppContext): void {
  if (context) throw new Error('AppContext 已初始化，禁止重复设置');
  context = value;
}

export function app(): AppContext {
  if (!context) throw new Error('AppContext 未初始化：main.ts 必须先运行 createAppContext');
  return context;
}
