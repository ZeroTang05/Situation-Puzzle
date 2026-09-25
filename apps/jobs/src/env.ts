/** jobs 进程环境配置：缺数据库地址立即失败。 */
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, '缺少 DATABASE_URL'),
  OPENCODE_API_KEY: z.string().default(''),
  JEV_BASE_URL: z.string().optional(),
  JEV_MODEL: z.string().optional(),
  JEV_THRESHOLD: z.string().optional(),
  JEV_LANGUAGE: z.enum(['zh', 'en']).default('zh'),
  JEV_PROMPT_VERSION: z.string().optional(),
  WECHAT_PAY_MCHID: z.string().optional(),
});

export type JobsEnv = z.infer<typeof envSchema>;

export function loadEnv(): JobsEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`环境配置校验失败 → ${issues}`);
  }
  return parsed.data;
}
