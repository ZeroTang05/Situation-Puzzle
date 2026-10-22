/**
 * 启动装配：pg-boss 队列、express 服务器（better-auth 路由 + JSON 解析）。
 * express 装配顺序至关重要：
 *   better-auth（需要原始请求体）→ 支付回调原始体 → JSON 解析 → Nest 路由
 */
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { hashPassword } from 'better-auth/crypto';
import { generateId } from 'better-auth';
import PgBoss from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { Env } from './env.js';
import { allowedOrigins } from './env.js';
import { account, profiles, roleAssignments, user } from '@jev/database';
import type { DbHandle } from '@jev/database';
import type { Mailer } from './auth/mailer.js';
import type { BetterAuthInstance } from './auth/auth.types.js';
import { defaultNickname } from './auth/auth.instance.js';
import { otpHttpContext } from './auth/otp-http-context.js';
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

/**
 * 挂载请求体解析器。**顺序不可交换**，理由见函数体注释。
 *
 * 单独抽出来是为了能直接对真实 express 断言解析结果——
 * 集成测试直调 service，绕过了 express 解析层，
 * 查不出「body 已经被上游解析器消费掉」这类问题（曾真实发生过，勿删）。
 */
export function mountBodyParsers(server: express.Express): void {
  // 支付回调需要原始请求体验签。
  //
  // 必须挂在 express.json 之前：
  //  - 微信支付的异步通知用的是 `Content-Type: application/json`；
  //  - express.json() 无条件匹配该类型并**消费掉请求流**，
  //    排在后面的话 express.raw 拿到的已不是原始字节（是解析好的对象），
  //    验签必然失败 → 回调被当作「验签失败」丢弃 → 用户付了钱拿不到权益；
  //  - 支付宝的通知是 `application/x-www-form-urlencoded`，不匹配 express.json，
  //    所以这个顺序问题只在微信通道暴露，容易漏掉。
  server.use('/api/v1/payments', express.raw({ type: '*/*', limit: '256kb' }));
  server.use(express.json({ limit: '256kb' }));
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
  const trustedProxies = input.env.TRUSTED_PROXY_CIDRS.split(',').map((value) => value.trim()).filter(Boolean);
  server.set('trust proxy', trustedProxies.length ? trustedProxies : false);
  // CORS 必须挂在 better-auth 之前：/api/v1/auth 路由先于 Nest 注册，Nest 的 enableCors 盖不到它。
  // App 壳（WebView 来源 https://localhost）跨站调用接口；网页端同源，无 Origin 时不加 CORS 头。
  const origins = new Set(allowedOrigins(input.env));
  const allowedHeaders = ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-jev-signup-otp', 'x-jev-otp-purpose', 'x-jev-language'];
  server.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined) res.setHeader('Vary', 'Origin');
    if (origin !== undefined && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', 'set-auth-token');
    }
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    if (origin !== undefined && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(','));
      res.setHeader('Access-Control-Max-Age', '600');
    }
    // 预检一律在这里短路；不在名单的来源拿不到放行头，浏览器侧自行拦截
    res.statusCode = 204;
    res.end();
  });
  // better-auth 处理 /api/v1/auth/*：必须拿到未经 JSON 解析的原始流
  server.use('/api/v1/auth', otpHttpContext(server.get('trust proxy fn')), toNodeHandler(input.auth.handler));
  mountBodyParsers(server);

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

  await ensureBootstrapAdmin(input.env, input.db);

  return context;
}

/**
 * 启动时用 BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD 直接建一个 admin 账号。
 *  - 用 better-auth 自带的 hashPassword 写 account.password（schema 列就是 better-auth 的存储）
 *  - 用户已存在：跳过建账号，但仍会保证有 admin 角色（idempotent）
 *  - 同步执行：必须在任何 admin 路由之前完成
 *  - PASSWORD 不提供时只看 EMAIL，若 EMAIL 已存在则补 admin 角色；不存在则报错引导
 */
async function ensureBootstrapAdmin(env: Env, db: DbHandle): Promise<void> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  if (!email) return;
  const password = env.BOOTSTRAP_ADMIN_PASSWORD?.trim() || undefined;
  const lower = email.toLowerCase();

  const [existing] = await db.db
    .select({ id: user.id, name: user.name, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, lower))
    .limit(1);

  if (existing) {
    console.log(`[bootstrap-admin] user ${lower} 已存在，跳过 user 创建`);
    // 用户已存在但可能没有 password（之前走的是 OTP 注册）→ 若提供了密码则补上
    if (password) {
      await db.tx(async (tx) => {
        const [cred] = await tx
          .select({ id: account.id, password: account.password })
          .from(account)
          .where(and(eq(account.userId, existing.id), eq(account.providerId, 'credential')))
          .limit(1);
        if (!cred) {
          await tx.insert(account).values({
            id: generateId(),
            userId: existing.id,
            accountId: existing.id,
            providerId: 'credential',
            password: await hashPassword(password),
          });
          console.log(`[bootstrap-admin] ${lower} 缺失 password，已补建 account 行`);
        } else if (!cred.password) {
          await tx
            .update(account)
            .set({ password: await hashPassword(password) })
            .where(eq(account.id, cred.id));
          console.log(`[bootstrap-admin] ${lower} account 行 password 为空，已更新为 BOOTSTRAP_ADMIN_PASSWORD`);
        } else {
          console.log(`[bootstrap-admin] ${lower} account.password 已有值，未覆盖`);
        }
      });
    }
    await grantAdminRole(db, existing.id, lower);
    return;
  }

  if (!password) {
    console.warn(
      `[bootstrap-admin] user ${lower} 不存在且未提供 BOOTSTRAP_ADMIN_PASSWORD，跳过创建。请先注册或设置完整凭据。`,
    );
    return;
  }
  if (password.length < 8) {
    console.warn(`[bootstrap-admin] BOOTSTRAP_ADMIN_PASSWORD 长度不足 8 位，跳过创建`);
    return;
  }

  const userId = generateId();
  const hashed = await hashPassword(password);

  await db.tx(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: lower.split('@')[0] ?? lower,
      email: lower,
      emailVerified: true, // 后台 bootstrap 直接信任邮箱已归属运维
    });
    // account 行：email/password 走 credential provider
    await tx.insert(account).values({
      id: generateId(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: hashed,
    });
    // profiles 行：与 user 1:1，昵称用「用户+随机编号」（不在昵称里暴露邮箱前缀）
    await tx.insert(profiles).values({ userId, nickname: defaultNickname() });
    await tx.insert(roleAssignments).values({ userId, role: 'admin' });
  });

  console.log(`[bootstrap-admin] user ${lower} 创建并已获 admin 角色`);
}

/**
 * 给已知 user 授 admin 角色（已存在则跳过）。
 */
async function grantAdminRole(db: DbHandle, userId: string, emailForLog: string): Promise<void> {
  await db.tx(async (tx) => {
    const [existing] = await tx
      .select({ role: roleAssignments.role })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId))
      .limit(1);
    if (existing) {
      console.log(`[bootstrap-admin] ${emailForLog} 已有角色 ${existing.role}，跳过`);
      return;
    }
    await tx.insert(roleAssignments).values({ userId, role: 'admin' });
    console.log(`[bootstrap-admin] ${emailForLog} 已获 admin 角色`);
  });
}
