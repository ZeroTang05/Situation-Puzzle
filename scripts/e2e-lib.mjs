/**
 * E2E 共享工具：HTTP 信封、邮箱验证码登录、实时客户端、断言收集。
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

export async function http(path, { method = 'GET', body, cookie, headers } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:8080',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers ?? {}),
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

/** 从收信台等最新一封邮件里的 6 位验证码。 */
async function waitForOtp(email) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const mails = JSON.parse(readFileSync(MAILSINK, 'utf8'));
      const mail = mails.filter((m) => m.to.includes(email)).at(-1);
      if (mail) {
        const match = mail.body.match(/\b(\d{6})\b/);
        if (match) return match[1];
      }
    } catch {
      /* 收信台未写盘，继续等 */
    }
  }
  throw new Error('60 秒内未收到验证码');
}

/** 邮箱验证码登录：发码 → 从收信台取码 → 验证码换会话 Cookie */
export async function login(email) {
  const sent = await http('/auth/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' } });
  if (sent.status !== 200) throw new Error(`发码失败：${sent.status} ${JSON.stringify(sent.body)}`);

  const otp = await waitForOtp(email);
  const verified = await http('/auth/sign-in/email-otp', { method: 'POST', body: { email, otp } });
  if (verified.status !== 200) throw new Error(`登录失败：${verified.status} ${JSON.stringify(verified.body)}`);
  const sessionCookie = verified.setCookies.map((c) => c.split(';')[0]).filter((c) => c.includes('session_token') || c.includes('session_data')).join('; ');
  if (!sessionCookie) throw new Error('登录响应没有会话 Cookie');
  return sessionCookie;
}

/** 注册新账号：发码（signup 用途）→ 消费验证码建号 → 密码登录拿会话 Cookie。 */
export async function register(email, name, password = 'e2e-password-1234') {
  const sent = await http('/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: { 'x-jev-otp-purpose': 'signup' },
    body: { email, type: 'sign-in' },
  });
  if (sent.status !== 200) throw new Error(`注册发码失败：${sent.status} ${JSON.stringify(sent.body)}`);

  const otp = await waitForOtp(email);
  const signup = await http('/auth/sign-up/email', {
    method: 'POST',
    headers: { 'x-jev-signup-otp': otp },
    body: { email, password, name },
  });
  if (signup.status !== 200) throw new Error(`注册失败：${signup.status} ${JSON.stringify(signup.body)}`);

  const signedIn = await http('/auth/sign-in/email', { method: 'POST', body: { email, password } });
  if (signedIn.status !== 200) throw new Error(`密码登录失败：${signedIn.status} ${JSON.stringify(signedIn.body)}`);
  const sessionCookie = signedIn.setCookies.map((c) => c.split(';')[0]).filter((c) => c.includes('session_token') || c.includes('session_data')).join('; ');
  if (!sessionCookie) throw new Error('登录响应没有会话 Cookie');
  return sessionCookie;
}

/**
 * 实时客户端：票据 → ws 连接 → 鉴权 → 订阅；收集事件帧。
 * WS 地址跟随 API 的 Origin（E2E 直打 8080）。
 */
export async function connectRealtime(cookie, roomId, lastSeq = 0) {
  const ticketResponse = await http('/realtime/tickets', { method: 'POST', cookie });
  const ticket = dataOf(ticketResponse).ticket;
  const { WebSocket } = requireFromApi('ws');
  const ws = new WebSocket('ws://localhost:8080/ws');
  const frames = [];
  const waiters = [];

  const deliver = (frame) => {
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(frame)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(frame);
      }
    }
  };

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', ticket }));
  const authed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    const onFrame = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'ack' && frame.userId) {
        clearTimeout(timer);
        ws.off('message', onFrame);
        resolve(frame);
      }
    };
    ws.on('message', onFrame);
  });
  if (!authed) throw new Error('ws 鉴权超时');
  ws.on('message', (raw) => {
    try {
      deliver(JSON.parse(raw.toString()));
    } catch {}
  });

  ws.send(JSON.stringify({ type: 'subscribe', roomId, lastSeq }));
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    const onFrame = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'sync.ready' && frame.roomId === roomId) {
        clearTimeout(timer);
        ws.off('message', onFrame);
        resolve(frame);
      }
    };
    ws.on('message', onFrame);
  });
  if (!ready) throw new Error('sync.ready 超时');

  return {
    ws,
    frames,
    waitFor(predicate, label, timeout = STEP_TIMEOUT) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.label === label);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`等待事件超时：${label}`));
        }, timeout);
        waiters.push({ predicate, resolve, timer, label });
      });
    },
  };
}

/** 等待一条问答的终态事件（判定完成或失败）。 */
export async function waitForTurnResult(realtime, turnId, label) {
  return realtime.waitFor(
    (f) => (f.type === 'turn.completed' || f.type === 'turn.failed') && f.payload?.turnId === turnId,
    label,
  );
}
