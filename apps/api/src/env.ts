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
  // 境内服务器出站中继：与内部 oauth-relay 部署成对使用（专用路径 + 共享密钥）
  GOOGLE_OAUTH_PROXY_BASE_URL: z.string().optional(),
  GOOGLE_OAUTH_PROXY_SHARED_SECRET: z.string().optional(),

  // Jev
  OPENCODE_API_KEY: z.string().default(''),
  JEV_BASE_URL: z.string().optional(),
  JEV_MODEL: z.string().optional(),
  JEV_THRESHOLD: z.string().optional(),
  JEV_LANGUAGE: z.enum(['zh', 'en']).default('zh'),

  // 支付：未配置时订单创建返回通道不可用（收费入口保持关闭）
  WECHAT_PAY_MCHID: z.string().optional(),
  WECHAT_PAY_APPID: z.string().optional(),
  WECHAT_PAY_SERIAL: z.string().optional(),
  WECHAT_PAY_PRIVATE_KEY_PATH: z.string().optional(),
  WECHAT_PAY_API_V3_KEY: z.string().optional(),
  WECHAT_PAY_NOTIFY_URL: z.string().optional(),

  /** 实时连接票据签名密钥（默认派生自 AUTH_SECRET） */
  REALTIME_TICKET_SECRET: z.string().optional(),
  /** 每进程单人 Jev 并发上限（首轮预算 2） */
  SOLO_JEV_CONCURRENCY: z.coerce.number().int().default(2),
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
  if (env.NODE_ENV === 'production') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      // 生产环境允许 Google 暂不开放（仅邮箱登录），但要明确记录
      console.warn('[env] 未配置 Google OAuth：生产环境将只有邮箱验证码登录');
    }
  }
  return env;
}
