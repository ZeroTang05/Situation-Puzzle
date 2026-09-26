/**
 * 真实通道探针（手工验证工具，不进 CI）：
 * 1. Resend：用 .env 里的真实密钥发一封验证码邮件，返回 Resend 的邮件 ID 即通道可用
 * 2. Google 代理：经 google-proxy.ts 的改写逻辑拉取 Google JWKS（GET，应 200）
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

const resendKey = envValue('.env', 'RESEND_API_KEY');
const from = envValue('.env', 'MAIL_FROM') ?? 'Jev <noreply@xiaobaozi.cn>';
const proxyBase = envValue('.env', 'GOOGLE_OAUTH_PROXY_BASE_URL');
if (!resendKey) throw new Error('.env 缺少 RESEND_API_KEY');

// ---- 1. Resend 真实发信 ----
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

// ---- 2. Google OAuth 代理（JWKS GET）----
if (!proxyBase) throw new Error('.env 缺少 GOOGLE_OAUTH_PROXY_BASE_URL');
const jwksUrl = `${proxyBase}/www.googleapis.com/oauth2/v3/certs`;
let jwks;
for (let attempt = 1; attempt <= 5 && !jwks; attempt++) {
  try {
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    jwks = await response.json();
  } catch (error) {
    // 本地到 Deno 节点的链路偶发抖动，重试
    console.log(`JWKS 第 ${attempt} 次失败（${error.message}），重试…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (!jwks) {
  console.error(`Google 代理 JWKS 拉取失败（已重试 5 次）：${jwksUrl}`);
  process.exit(1);
}
console.log(`Google 代理 JWKS 拉取成功：${jwks.keys?.length ?? 0} 把公钥`);
console.log('注意：token 兑换（POST /oauth2.googleapis.com/token）依赖代理节点支持 googleapis POST，当前节点该项故障需修复');
