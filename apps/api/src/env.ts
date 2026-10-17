/**
 * 环境配置：启动时一次性校验，缺失必需项立即失败（docs/rebuild/03-SPEC.md §8）。
 * 密钥不进镜像与仓库；.env.example 是唯一模板来源。
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1, '缺少数据库地址'),

  /** 会话与令牌签名密钥（32 字节以上随机串） */
  AUTH_SECRET: z.string().min(16, '缺少 AUTH_SECRET'),
  /** 单人凭证签名密钥 */
  SOLO_TOKEN_SECRET: z.string().min(16, '缺少 SOLO_TOKEN_SECRET'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:5173'),
  /** App 壳（Capacitor WebView）等额外允许的跨站来源，逗号分隔；CORS 与 trustedOrigins 共用 */
  APP_EXTRA_ORIGINS: z.string().default(''),
  /** 仅信任列出的代理地址/CIDR；留空表示 API 直接接受浏览器连接。 */
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  /** 多人房间与会客厅的座位容量（含房主），2–50；网页端不选人数，服务端以此值为准（重开会客厅时按新值更新） */
  ROOM_CAPACITY: z.coerce.number().int().min(2).max(50).default(8),
  /** 判题附带的最近问答轮数（0=关闭），单人/多人共用；单人客户端最多发 10 条，服务端按此值裁剪 */
  JEV_RECENT_QA_LIMIT: z.coerce.number().int().min(0).max(10).default(6),

  // 邮件（Email OTP 必需）：通道由 MAIL_TRANSPORT 显式选择，配置缺失启动失败
  MAIL_TRANSPORT: z.enum(['resend', 'smtp']).default('resend'),
  // Resend 通道（生产）：与内部其他项目共用同一 Resend 账号
  RESEND_API_KEY: z.string().optional(),
  // SMTP 通道（本地联调，投递给 dev-mailsink 收信台）
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(1, '缺少 MAIL_FROM（发件地址）'),

  // Google OAuth：可选配置——未配置时 Google 按钮隐藏、调用直接报错
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // LINUX DO OAuth（connect.linux.do）：可选配置——未配置时 LINUX DO 按钮隐藏
  LINUXDO_OAUTH_CLIENT_ID: z.string().optional(),
  LINUXDO_OAUTH_CLIENT_SECRET: z.string().optional(),
  // 境内服务器出站中继：与内部 oauth-relay 部署成对使用（专用路径 + 共享密钥），
  // Google 与 LINUX DO 的服务端出站请求共用同一个中继
  GOOGLE_OAUTH_PROXY_BASE_URL: z.string().optional(),
  GOOGLE_OAUTH_PROXY_SHARED_SECRET: z.string().optional(),

  // Jev
  OPENCODE_API_KEY: z.string().default(''),
  JEV_BASE_URL: z.string().optional(),
  JEV_MODEL: z.string().optional(),
  JEV_THRESHOLD: z.string().optional(),
  JEV_LANGUAGE: z.enum(['zh', 'en']).default('zh'),
  JEV_PROMPT_VERSION: z.string().optional(),
  MINIMAX_API_KEY: z.string().min(1, '缺少 MINIMAX_API_KEY'),
  MINIMAX_BASE_URL: z.url().optional(),
  MINIMAX_MODEL: z.string().min(1).optional(),

  // 支付：未配置时订单创建返回通道不可用（收费入口保持关闭）
  WECHAT_PAY_MCHID: z.string().optional(),
  WECHAT_PAY_APPID: z.string().optional(),
  WECHAT_PAY_SERIAL: z.string().optional(),
  WECHAT_PAY_PRIVATE_KEY_PATH: z.string().optional(),
  WECHAT_PAY_API_V3_KEY: z.string().optional(),
  WECHAT_PAY_NOTIFY_URL: z.string().optional(),

  /** 实时连接票据签名密钥（默认派生自 AUTH_SECRET） */
  REALTIME_TICKET_SECRET: z.string().optional(),
  /** 每进程单人 Jev 并发上限（按服务器与 Jev 真实容量调整，默认 2） */
  SOLO_JEV_CONCURRENCY: z.coerce.number().int().default(2),

  /** Bootstrap admin：启动时若 user 不存在则创建（按 better-auth 标准 hash 存 account.password）；
   *  写完 user 后插入 role_assignments.role='admin'。已存在则跳过建账号，仅补 admin 角色。
   *  该变量仍可保留作"兜底授角色"，与 BOOTSTRAP_ADMIN/EMAIL+PASSWORD 独立使用。 */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`环境配置校验失败 → ${issues}`);
  }
  const env = parsed.data;
  // 邮件通道跨字段校验：所选通道的必需配置缺失就立即失败
  if (env.MAIL_TRANSPORT === 'resend' && !env.RESEND_API_KEY) {
    throw new Error('环境配置校验失败 → MAIL_TRANSPORT=resend 需要配置 RESEND_API_KEY');
  }
  if (env.MAIL_TRANSPORT === 'smtp' && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)) {
    throw new Error('环境配置校验失败 → MAIL_TRANSPORT=smtp 需要配置 SMTP_HOST / SMTP_USER / SMTP_PASS');
  }
  if (env.GOOGLE_OAUTH_PROXY_BASE_URL && !env.GOOGLE_OAUTH_PROXY_SHARED_SECRET) {
    throw new Error('环境配置校验失败 → 配置了 GOOGLE_OAUTH_PROXY_BASE_URL 就必须配置 GOOGLE_OAUTH_PROXY_SHARED_SECRET');
  }
  parseExtraOrigins(env.APP_EXTRA_ORIGINS);
  if (env.NODE_ENV === 'production') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      // 生产环境允许第三方登录暂不开放（邮箱/密码登录兜底），但要明确记录
      console.warn('[env] 未配置 Google OAuth：生产环境将没有 Google 登录');
    }
    if (!env.LINUXDO_OAUTH_CLIENT_ID || !env.LINUXDO_OAUTH_CLIENT_SECRET) {
      console.warn('[env] 未配置 LinuxDo OAuth：生产环境将没有 LINUX DO 登录');
    }
  }
  return env;
}

/** 解析 APP_EXTRA_ORIGINS：只接受 http(s) 纯 origin（不带路径/结尾斜杠），非法值就地失败。 */
function parseExtraOrigins(raw: string): string[] {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`环境配置校验失败 → APP_EXTRA_ORIGINS 含非法来源：${value}`);
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== value) {
      throw new Error(`环境配置校验失败 → APP_EXTRA_ORIGINS 只接受 http(s) origin（不带路径）：${value}`);
    }
  }
  return values;
}

/** 全部允许的浏览器来源：网页主站 + 额外来源（CORS 与 better-auth trustedOrigins 共用）。 */
export function allowedOrigins(env: Env): string[] {
  return [...new Set([env.PUBLIC_BASE_URL, ...parseExtraOrigins(env.APP_EXTRA_ORIGINS)])];
}
