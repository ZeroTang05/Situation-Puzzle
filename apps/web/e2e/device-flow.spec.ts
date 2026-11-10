/** 真实 SMTP、API 和浏览器验证：登录回流、明确确认、拒绝及会话兑换。 */
import { test, expect } from '@playwright/test';
import { deviceAuthorizationSchema, deviceTokenSchema } from '@jev/contracts';
import { signUpWithOtp } from './auth-helper';

test('官网账号允许或拒绝小游戏设备登录，移动端可操作', async ({ page, context }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const password = 'Device-Approval-E2E-2026';
  const email = await signUpWithOtp(context, { prefix: 'device', name: '授权验收', password });
  await context.clearCookies();
  const issued = await context.request.post('/api/v1/auth/device/code', { data: { client_id: 'tapmcmnlmv6v8lx5mb' } });
  expect(issued.ok()).toBe(true);
  const device = deviceAuthorizationSchema.parse(await issued.json());
  await page.goto(`/device?user_code=${device.user_code}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/device\\?user_code=${device.user_code}`));
  await expect(page).toHaveTitle(/超好玩海龟汤/);
  await expect(page.getByRole('heading', { name: '登录 TapTap 小游戏' })).toBeVisible();
  await expect(page.getByText(device.user_code, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许登录', exact: true })).toBeEnabled();
  if (process.env.DEVICE_QA_DIR) await page.screenshot({ path: `${process.env.DEVICE_QA_DIR}/device-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('button', { name: '允许登录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.DEVICE_QA_DIR) await page.screenshot({ path: `${process.env.DEVICE_QA_DIR}/device-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: '允许登录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已允许登录，请回到小游戏。');
  const tokenResponse = await context.request.post('/api/v1/auth/device/token', { data: { client_id: 'tapmcmnlmv6v8lx5mb', device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
  expect(tokenResponse.ok()).toBe(true);
  deviceTokenSchema.parse(await tokenResponse.json());

  const deniedRequest = await context.request.post('/api/v1/auth/device/code', { data: { client_id: 'tapmcmnlmv6v8lx5mb' } });
  const denied = deviceAuthorizationSchema.parse(await deniedRequest.json());
  await page.goto(`/device?user_code=${denied.user_code}`);
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已拒绝登录');
  const deniedResponse = await context.request.post('/api/v1/auth/device/token', { data: { client_id: 'tapmcmnlmv6v8lx5mb', device_code: denied.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
  expect(deniedResponse.status()).toBe(400);
  expect((await deniedResponse.json()).error).toBe('access_denied');
  expect(consoleErrors).toEqual([]);
});
