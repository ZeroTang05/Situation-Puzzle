/**
 * 一次性联调辅助：以指定邮箱登录并把房主转给目标用户。
 * 用法：node scripts/e2e-transfer-host.mjs <roomId> <fromEmail> <toUserId>
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));

const BASE = 'http://localhost:8080/api/v1';
const MAILSINK = 'E:/tzy/github/jev-turtle-soup/mailsink.json';
const [, , roomId, fromEmail, toUserId] = process.argv;

async function http(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:5173',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload, setCookies };
}

const sent = await http('/auth/email-otp/send-verification-otp', { method: 'POST', body: { email: fromEmail, type: 'sign-in' } });
if (sent.status !== 200) throw new Error(`发码失败 ${sent.status}`);
let otp = null;
for (let i = 0; i < 30 && !otp; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const mails = JSON.parse(readFileSync(MAILSINK, 'utf8'));
    const mail = mails.filter((m) => m.to.includes(fromEmail)).at(-1);
    if (mail) otp = mail.body.match(/\b(\d{6})\b/)?.[1];
  } catch {}
}
const verified = await http('/auth/sign-in/email-otp', { method: 'POST', body: { email: fromEmail, otp } });
const cookie = verified.setCookies.map((c) => c.split(';')[0]).join('; ');

const result = await http(`/rooms/${roomId}/commands`, {
  method: 'POST',
  cookie,
  body: { clientRequestId: crypto.randomUUID(), type: 'transfer_host', payload: { userId: toUserId } },
});
console.log(`transfer_host → ${result.status} ${JSON.stringify(result.body?.data ?? result.body?.error)}`);
