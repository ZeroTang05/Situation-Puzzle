/** e2e 共用的注册辅助：走真实验证码流程建号（服务端注册闸门要求消费验证码）。 */
import { readFile } from 'node:fs/promises';
import type { BrowserContext } from '@playwright/test';

/** 测试邮箱统一域名：避开一次性域名黑名单（.test 为保留的测试专用 TLD）。 */
export const E2E_EMAIL_DOMAIN = 'jev-e2e.test';

/** 从真实收信台文件里轮询取该邮箱最新一封邮件的 6 位验证码（邮件投递有延迟）。 */
async function latestOtp(email: string): Promise<string> {
  const mailboxPath = process.env.E2E_MAILSINK_PATH;
  if (!mailboxPath) throw new Error('需要 E2E_MAILSINK_PATH 指向真实 SMTP 收信台文件');
  for (let attempt = 0; attempt < 20; attempt++) {
    const mails = JSON.parse(await readFile(mailboxPath, 'utf8')) as Array<{ to: string; body?: string; text?: string }>;
    const mail = mails.filter((item) => item.to.includes(email)).at(-1);
    const code = (mail?.text ?? mail?.body)?.match(/\b\d{6}\b/)?.[0];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`真实收信台没有 ${email} 的验证码`);
}

/** 发码 → 收信台取码 → 带验证码头注册；登录 Cookie 由传入的浏览器上下文保存。 */
export async function signUpWithOtp(context: BrowserContext, options: { prefix: string; name: string; password: string }): Promise<string> {
  const email = `${options.prefix}-${crypto.randomUUID()}@${E2E_EMAIL_DOMAIN}`;
  const sent = await context.request.post('/api/v1/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' } });
  if (!sent.ok()) throw new Error(`验证码发送失败：${await sent.text()}`);
  const otp = await latestOtp(email);
  const response = await context.request.post('/api/v1/auth/sign-up/email', {
    headers: { 'x-jev-signup-otp': otp },
    data: { email, password: options.password, name: options.name },
  });
  if (!response.ok()) throw new Error(`注册失败：${await response.text()}`);
  return email;
}
