/** 真实邮件、API 与浏览器验证发送限制；在额度为空的独立开发测试服务上运行。 */
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('登录注册共用发送额度，刷新保留倒计时，IP 用完仍可验证旧验证码', async ({ page, context }) => {
  test.setTimeout(180_000);
  const mailboxPath = process.env.E2E_MAILSINK_PATH;
  if (!mailboxPath) throw new Error('需要 E2E_MAILSINK_PATH 指向真实 SMTP 收信台文件');
  const email = `otp-${crypto.randomUUID()}@example.com`;
  await page.goto('/login?lang=zh');
  await page.getByRole('link', { name: '去注册', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByRole('button', { name: /秒后重试/ })).toBeDisabled();
  await expect(page.getByLabel('验证码', { exact: true })).toBeEnabled();
  await page.getByRole('link', { name: '去登录', exact: true }).click();
  await page.getByRole('button', { name: '邮箱验证码', exact: true }).click();
  await expect(page.getByRole('button', { name: /秒后重试/ })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: '邮箱验证码', exact: true }).click();
  await expect(page.getByRole('button', { name: /秒后重试/ })).toBeDisabled();
  await expect(page.getByLabel('验证码', { exact: true })).toBeEnabled();
  const repeated = await context.request.post('/api/v1/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' } });
  expect(repeated.status()).toBe(429);
  const repeatedBody = await repeated.json();
  expect(repeatedBody.limitScope).toBe('email');
  expect(repeatedBody.retryAfterSeconds).toBeGreaterThan(0);
  expect(Number(repeated.headers()['retry-after'])).toBe(repeatedBody.retryAfterSeconds);
  for (let index = 0; index < 2; index++) {
    const response = await context.request.post('/api/v1/auth/email-otp/send-verification-otp', { data: { email: `otp-other-${crypto.randomUUID()}@example.com`, type: 'sign-in' } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const forged = await context.request.post('/api/v1/auth/email-otp/send-verification-otp', { headers: { 'X-Forwarded-For': '198.51.100.80', 'X-Jev-Client-IP': '198.51.100.81' }, data: { email: `otp-forged-${crypto.randomUUID()}@example.com`, type: 'sign-in' } });
  expect(forged.status()).toBe(429);
  expect((await forged.json()).limitScope).toBe('ip');
  await expect(page.getByRole('button', { name: /秒后重试/ })).toHaveCount(0, { timeout: 70_000 });
  await page.getByLabel('Email', { exact: true }).fill(`otp-limited-${crypto.randomUUID()}@example.com`);
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('发送过于频繁');
  await expect(page.getByRole('button', { name: /秒后重试/ })).toBeDisabled();
  await expect(page.getByLabel('验证码', { exact: true })).toBeEnabled();
  const mails = JSON.parse(await readFile(mailboxPath, 'utf8')) as Array<{ to: string; body?: string; text?: string }>;
  const mail = mails.filter((item) => item.to.includes(email)).at(-1);
  const code = (mail?.text ?? mail?.body)?.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error('真实收信台没有该邮箱的验证码');
  await page.getByRole('link', { name: '去注册', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('验证码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '验证邮箱', exact: true }).click();
  await expect(page.getByText('✓ 邮箱已验证')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('Jev-OTP-E2E-password-2026');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page).toHaveURL('/');
});
