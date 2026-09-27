/**
 * E2E 共享工具：HTTP 信封、邮箱验证码登录、断言收集。
 * 依赖运行中的 API（:8080）与 dev-mailsink 收信台；由 scripts/e2e-run.sh 编排。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// scripts/ 不在工作区依赖图内：从 apps/api 的依赖里解析 ws 与 pg
export const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));

export const BASE = 'http://localhost:8080/api/v1';
export const MAILSINK = new URL('../mailsink.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const STEP_TIMEOUT = 70_000;

let passed = 0;
const failures = [];

export function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

export function summary() {
  console.log(`\n断言通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项：${failures.join('；')}` : ''}`);
  process.exit(failures.length ? 1 : 0);
}

export async function http(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:8080',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload, setCookies };
}

export function dataOf(response) {
  return response.body?.data;
}

export function errorOf(response) {
  return response.body?.error ?? { code: `HTTP_${response.status}`, message: '' };
}

/** 邮箱验证码登录：发码 → 从收信台取码 → 验证码换会话 Cookie */
export async function login(email) {
  const sent = await http('/auth/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' } });
  if (sent.status !== 200) throw new Error(`发码失败：${sent.status} ${JSON.stringify(sent.body)}`);

  let otp = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const mails = JSON.parse(readFileSync(MAILSINK, 'utf8'));
      const mail = mails.filter((m) => m.to.includes(email)).at(-1);
      if (mail) {
        const match = mail.body.match(/\b(\d{6})\b/);
        if (match) {
          otp = match[1];
          break;
        }
      }
    } catch {
      /* 收信台未写盘，继续等 */
    }
  }
  if (!otp) throw new Error('60 秒内未收到验证码');

  const verified = await http('/auth/sign-in/email-otp', { method: 'POST', body: { email, otp } });
  if (verified.status !== 200) throw new Error(`登录失败：${verified.status} ${JSON.stringify(verified.body)}`);
  const sessionCookie = verified.setCookies.map((c) => c.split(';')[0]).filter((c) => c.includes('session_token') || c.includes('session_data')).join('; ');
  if (!sessionCookie) throw new Error('登录响应没有会话 Cookie');
  return sessionCookie;
}
