/** 从环境变量构建判题配置：缺失密钥时延迟到调用时失败（单人/多人共用）。 */
import type { JevConfig, Language } from './types.js';

export function jevConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const threshold = Number(env.JEV_THRESHOLD ?? '0.5');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`JEV_THRESHOLD 不合法：${env.JEV_THRESHOLD}`);
  }
  const language: Language = env.JEV_LANGUAGE === 'en' ? 'en' : 'zh';
  return {
    apiKey: env.OPENCODE_API_KEY ?? '',
    baseUrl: env.JEV_BASE_URL ?? 'https://opencode.ai/zen/v1/systemone',
    model: env.JEV_MODEL ?? 'jev-1.13',
    threshold,
    promptVersion: env.JEV_PROMPT_VERSION ?? 'v1-2026-09',
    attemptTimeoutMs: 20_000,
    totalDeadlineMs: 45_000,
    language,
  };
}
