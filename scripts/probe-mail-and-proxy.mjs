/**
 * 登录通道探针（手工验证工具，不进 CI）：
 * 1. Resend：用 .env 里的真实密钥发一封验证码邮件，返回 Resend 的邮件 ID 即通道可用
 * 2. Google OAuth 中继：按 oauth-relay 调用约定（专用路径 + X-Relay-Token）实测：
 *    healthz / token 兑换（假凭据→Google 400）/ userinfo（假 Bearer→Google 401）
 *
 * 用法：node scripts/probe-mail-and-proxy.mjs [收件邮箱]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

function envValue(file, name) {
  const line = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(name.length + 1).trim();
}

// ---- 1. Resend 真实发信 ----
const resendKey = envValue('.env', 'RESEND_API_KEY');
const from = envValue('.env', 'MAIL_FROM') ?? 'Jev <noreply@xiaobaozi.cn>';
if (!resendKey) throw new Error('.env 缺少 RESEND_API_KEY');
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Resend } = apiRequire('resend');
const resend = new Resend(resendKey);
const to = process.argv[2] ?? 'delivered@resend.dev';
const code = String(Math.floor(100000 + Math.random() * 900000));
const sent = await resend.emails.send({
  from,
  to,
  subject: 'Jev 登录验证码（通道验证）',
  text: `你的 Jev 登录验证码是 ${code}，5 分钟内有效。`,
  html: `<p>你的 Jev 登录验证码是：<b>${code}</b>（5 分钟内有效）</p>`,
});
if (sent.error) {
  console.error('Resend 发信失败：', sent.error);
  process.exit(1);
}
console.log(`Resend 发信成功：id=${sent.data?.id} to=${to}`);

// ---- 2. Google OAuth 中继 ----
const base = envValue('.env', 'GOOGLE_OAUTH_PROXY_BASE_URL');
const secret = envValue('.env', 'GOOGLE_OAUTH_PROXY_SHARED_SECRET');
if (!base || !secret) throw new Error('.env 缺少 GOOGLE_OAUTH_PROXY_BASE_URL / GOOGLE_OAUTH_PROXY_SHARED_SECRET');

const FAKE = 'https://oauth2.googleapis.com/token';

/** 带重试的 fetch（本地到中继链路偶发抖动） */
async function fetchRetry(url, init, tries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
    } catch (error) {
      lastError = error;
      console.log(`第 ${attempt} 次失败（${error.message}），重试…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

// 1. healthz
const health = await fetchRetry(`${base}/healthz`);
console.log(`healthz: HTTP ${health.status} ${await health.text()}`);
if (health.status !== 200) process.exit(1);

// 2. token 兑换（假凭据）：Google 返回 400 即证明链路通
const token = await fetchRetry(`${base}/oauth/google/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-relay-token': secret },
  body: 'code=fake&grant_type=authorization_code&client_id=fake.apps.googleusercontent.com&client_secret=fake&redirect_uri=https://x.test/cb',
});
console.log(`token(假凭据): HTTP ${token.status}`);
if (token.status !== 400) {
  console.error('应返回 Google 的 400（invalid client/grant）');
  process.exit(1);
}

// 3. userinfo（假 Bearer）：Google 返回 401 JSON 即证明链路通
const userinfo = await fetchRetry(`${base}/oauth/google/userinfo`, {
  headers: { authorization: 'Bearer fake', 'x-relay-token': secret },
});
const body = await userinfo.json();
console.log(`userinfo(假Bearer): HTTP ${userinfo.status} ${JSON.stringify(body)}`);
if (userinfo.status !== 401 || body.error !== 'invalid_request') {
  console.error('应返回 Google 的 401 invalid_request');
  process.exit(1);
}
console.log('中继两段链路全部打通 ✓（真实凭据即可登录）');
