/**
 * 浏览器联调的客人端第二客户端：登录 → 邀请加入 → WS 订阅 →
 * 看到 round.started 后自动提问 → 等待真实 Jev 判定 → 持续打印事件直到被结束。
 * 用法：node scripts/e2e-guest-client.mjs <inviteToken> <email>
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const pg = requireFromApi('pg');
const { WebSocket } = requireFromApi('ws');

const BASE = 'http://localhost:8080/api/v1';
const MAILSINK = 'E:/tzy/github/jev-turtle-soup/mailsink.json';
const [, , inviteToken, email = 'uiguest@e2e.test'] = process.argv;

if (!inviteToken) {
  console.error('[guest] 用法：node scripts/e2e-guest-client.mjs <inviteToken> [email]');
  process.exit(1);
}

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
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  return { status: response.status, body: payload, setCookies };
}

async function login() {
  const sent = await http('/auth/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' } });
  if (sent.status !== 200) throw new Error(`发码失败 ${sent.status}`);
  let otp = null;
  for (let i = 0; i < 30 && !otp; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const mails = JSON.parse(readFileSync(MAILSINK, 'utf8'));
      const mail = mails.filter((m) => m.to.includes(email)).at(-1);
      if (mail) otp = mail.body.match(/\b(\d{6})\b/)?.[1];
    } catch {}
  }
  const verified = await http('/auth/sign-in/email-otp', { method: 'POST', body: { email, otp } });
  if (verified.status !== 200) throw new Error(`登录失败 ${verified.status}`);
  return verified.setCookies.map((c) => c.split(';')[0]).join('; ');
}

const cookie = await login();
console.log(`[guest] ${email} 登录成功`);

const joined = await http('/rooms/join', { method: 'POST', cookie, body: { token: inviteToken } });
const roomId = joined.body?.data?.roomId;
if (!roomId) throw new Error(`加入失败：${JSON.stringify(joined.body)}`);
console.log(`[guest] 已加入房间 ${roomId}`);

const ticket = (await http('/realtime/tickets', { method: 'POST', cookie })).body.data.ticket;
const ws = new WebSocket('ws://localhost:8080/ws');
let lastSeq = 0;
let myUserId = null;
let asked = false;
let currentRoundId = null;
let turnCount = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', ticket }));
});

function send(frame) {
  ws.send(JSON.stringify(frame));
}

function handleEvent(frame) {
  if (frame.seq !== undefined) lastSeq = Math.max(lastSeq, frame.seq);
  if (frame.type === undefined) return;
  console.log(`[guest 事件] ${frame.type} ${JSON.stringify(frame.payload ?? {}).slice(0, 160)}`);
  if (frame.type === 'round.started' && frame.payload?.roundId) {
    currentRoundId = frame.payload.roundId;
  }
  if (frame.type === 'round.ended') {
    currentRoundId = null;
  }
  // 本局进行中且还没提问过：提交一个真实问题
  if (frame.type === 'round.started' && !asked) {
    asked = true;
    setTimeout(async () => {
      const ask = await http(`/rooms/${roomId}/commands`, {
        method: 'POST',
        cookie,
        body: {
          clientRequestId: crypto.randomUUID(),
          type: 'ask',
          roundId: currentRoundId,
          payload: { text: '毒是在热茶里，还是在冰块里？' },
        },
      });
      console.log(`[guest] 提问受理：${ask.status} ${JSON.stringify(ask.body?.data ?? ask.body?.error ?? {})}`);
    }, 1200);
  }
  if (frame.type === 'round.ended' && asked) {
    console.log('[guest] 本局结束，客人端联调完成 ✓');
  }
}

ws.on('message', async (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type === 'ack' && frame.userId) {
    myUserId = frame.userId;
    send({ type: 'subscribe', roomId, lastSeq: 0 });
    return;
  }
  if (frame.type === 'sync.ready') {
    console.log(`[guest] sync.ready watermark=${frame.watermark}`);
    return;
  }
  if (frame.type && frame.seq !== undefined) handleEvent(frame);
});

ws.on('error', (e) => console.error('[guest ws 错误]', e.message));
// 应用层心跳：与真实 web 客户端一致，15 秒一次，保持 presence 与连接活性
setInterval(() => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
}, 15_000);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 60_000);
