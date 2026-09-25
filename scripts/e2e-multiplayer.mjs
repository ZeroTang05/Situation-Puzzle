/**
 * 双用户多人房间端到端联调（真实进程 + 真实数据库 + 真实 WebSocket + 真实 Jev）：
 *   用户 A（房主）：登录 → 建房（预留免费次数）→ 选题 → 开局 → 提示 → 讨论 → 公布答案 → 第二局 → 关房
 *   用户 B（客人）：登录 → 邀请加入 → WS 订阅 → 提问（真实 Jev 判定）→ 还原 → 收到全部事件
 * 校验：事件同步一致性、免费账本 reserve→consume 唯一流水、同房第二局不重复扣次、
 *       jev_calls 落库、汤底仅揭晓后可读。
 * 运行：cd apps/api && node ../../scripts/e2e-multiplayer.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// scripts/ 不在工作区依赖图内：从 apps/api 的依赖里解析 ws 与 pg
const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const pg = requireFromApi('pg');

const BASE = 'http://localhost:8080/api/v1';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://jev:jev@localhost:54329/jev';
const MAILSINK = new URL('../mailsink.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STEP_TIMEOUT = 70_000;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function http(path, { method = 'GET', body, cookie } = {}) {
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

function dataOf(response) {
  return response.body?.data;
}

function errorOf(response) {
  return response.body?.error ?? { code: `HTTP_${response.status}`, message: '' };
}

/** 邮箱验证码登录：发码 → 从收信台取码 → 验证码换会话 Cookie */
async function login(email) {
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

/** 实时客户端：票据 → ws 连接 → 鉴权 → 订阅；收集事件帧 */
async function connectRealtime(cookie, roomId, lastSeq = 0) {
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

async function command(cookie, roomId, type, payload = {}, extra = {}) {
  return http(`/rooms/${roomId}/commands`, {
    method: 'POST',
    cookie,
    body: { clientRequestId: crypto.randomUUID(), type, payload, ...extra },
  });
}

async function waitForTurnResult(realtime, turnId, label) {
  const frame = await realtime.waitFor(
    (f) => (f.type === 'turn.completed' || f.type === 'turn.failed') && f.payload?.turnId === turnId,
    label,
  );
  return frame;
}

const pool = new pg.Pool({ connectionString: DB_URL });
async function query(text, values) {
  const result = await pool.query(text, values);
  return result.rows;
}

// ============================================================

const HOST = `host-${Date.now()}@e2e.test`;
const GUEST = `guest-${Date.now()}@e2e.test`;

console.log('== 1. 双用户邮箱验证码登录（真实 SMTP 收信台）==');
const hostCookie = await login(HOST);
const guestCookie = await login(GUEST);
check('房主登录成功', hostCookie.length > 0);
check('客人登录成功', guestCookie.length > 0);

const hostMe = dataOf(await http('/me', { cookie: hostCookie }));
check('免费开房账户初始化为 10/0/0', hostMe.freeRooms.total === 10 && hostMe.freeRooms.consumed === 0 && hostMe.freeRooms.reserved === 0, JSON.stringify(hostMe.freeRooms));

console.log('== 2. 房主建房（预留免费次数）==');
const created = dataOf(await http('/rooms', { method: 'POST', cookie: hostCookie, body: { capacity: 8 } }));
check('建房成功', Boolean(created.roomId));
check('邀请令牌只发一次', Boolean(created.inviteToken));
const roomId = created.roomId;
const inviteToken = created.inviteToken;

const hostRealtime = await connectRealtime(hostCookie, roomId, 0);
check('房主 WS 快照握手 sync.ready', hostRealtime.frames.some((f) => f.type === 'sync.ready'));

const reserved = await query('select consumed, reserved from free_room_accounts where user_id = $1', [hostMe.userId]);
check('建房后预留 1 次（consumed=0, reserved=1）', reserved[0]?.consumed === 0 && reserved[0]?.reserved === 1, JSON.stringify(reserved[0]));

console.log('== 3. 选题并开局 ==');
const catalog = dataOf(await http('/puzzles?language=zh&limit=50'));
const puzzle = catalog.items.find((p) => p.legacyId === 'seed-classic-iced-drinks') ?? catalog.items[0];
const selectResponse = await command(hostCookie, roomId, 'select_puzzle', { puzzleId: puzzle.id, language: 'zh' }, { expectedControlVersion: 0 });
check('房主选题受理', selectResponse.status === 202 && dataOf(selectResponse).status === 'accepted');
const controlVersion = dataOf(selectResponse).controlVersion;
check('控制命令推进控制版本', controlVersion === 1);

const startResponse = await command(hostCookie, roomId, 'start_round', {}, { expectedControlVersion: controlVersion });
check('开局受理', startResponse.status === 202);
const startedEvent = await hostRealtime.waitFor((f) => f.type === 'round.started', 'round.started');
const roundId = startedEvent.payload.roundId;
check('round.started 事件携带汤面（不含汤底）', typeof startedEvent.payload.surface === 'string' && startedEvent.payload.answer === undefined);

console.log('== 4. 客人凭邀请加入（晚加入进行中的局）==');
const guestCookieJoin = await http('/rooms/join', { method: 'POST', cookie: guestCookie, body: { token: inviteToken } });
check('客人加入成功', guestCookieJoin.status === 202);
const guestMe = dataOf(await http('/me', { cookie: guestCookie }));
const guestRealtime = await connectRealtime(guestCookie, roomId, 0);
const guestSnapshotEvents = guestRealtime.frames.filter((f) => f.type !== 'ack' && f.type !== 'sync.ready' && f.type !== 'heartbeat');
check('客人补齐了加入前的全部事件（round.started 等）', guestSnapshotEvents.some((f) => f.type === 'round.started'));
await hostRealtime.waitFor((f) => f.type === 'room.member_joined' && f.payload.nickname?.includes('guest'), 'member_joined');
check('房主实时收到成员加入事件', true);

console.log('== 5. 客人提问 → 真实 Jev 判定 ==');
const askResponse = await command(guestCookie, roomId, 'ask', { text: '冰块本身有毒吗？' }, { roundId });
check('提问受理 202', askResponse.status === 202);
const turnId = dataOf(askResponse).turnId;
const acceptedSeq = dataOf(askResponse).acceptedSeq;
check('返回问答编号与事件序号', Boolean(turnId) && Number.isInteger(acceptedSeq));

await hostRealtime.waitFor((f) => f.type === 'turn.accepted' && f.payload?.turnId === turnId, 'host sees turn.accepted');
check('房主实时看到客人提问', true);

const completedFrame = await waitForTurnResult(guestRealtime, turnId, 'turn.completed (真实 Jev)');
check('真实 Jev 判定返回（turn.completed）', completedFrame.type === 'turn.completed', completedFrame.type);
check('判定是稳定枚举', ['yes', 'no', 'irrelevant', 'uncertain'].includes(completedFrame.payload.result), completedFrame.payload.result);
await hostRealtime.waitFor((f) => f.type === 'turn.completed' && f.payload?.turnId === turnId, 'host sees completed');
check('两端收到同一条判定的同一编号', true);

const calls = await query('select status, choice, confidence, error_class from jev_calls where turn_id = $1 order by attempt', [turnId]);
check('jev_calls 落库（真实调用记录）', calls.length >= 1 && calls[0].status === 'ok', JSON.stringify(calls));

const afterFirst = await query('select consumed, reserved from free_room_accounts where user_id = $1', [hostMe.userId]);
check('首次有效判定消费免费次数（reserved 1→0, consumed 0→1）', afterFirst[0]?.consumed === 1 && afterFirst[0]?.reserved === 0, JSON.stringify(afterFirst[0]));
const ledger = await query("select action from room_credit_ledger where room_id = $1 order by action", [roomId]);
check('账本恰好一条 reserve + 一条 consume', ledger.length === 2 && ledger.some((l) => l.action === 'reserve') && ledger.some((l) => l.action === 'consume'), JSON.stringify(ledger));

console.log('== 6. 房主解锁提示、双方讨论 ==');
await command(hostCookie, roomId, 'reveal_hint', {}, { expectedControlVersion: controlVersion + 1 });
const hintEvent = await guestRealtime.waitFor((f) => f.type === 'hint.revealed', 'hint.revealed');
check('客人实时收到提示事件', typeof hintEvent.payload.text === 'string' && hintEvent.payload.index === 0);

await command(guestCookie, roomId, 'discussion', { text: '我怀疑毒在茶里，不在冰块里。' }, { roundId });
await hostRealtime.waitFor((f) => f.type === 'discussion.created', 'discussion.created');
check('房主实时收到讨论消息', true);

console.log('== 7. 客人还原（第二次真实 Jev 判定）==');
const solveResponse = await command(guestCookie, roomId, 'solve', { text: '毒被放在慢喝的人的杯子里，或者热茶融化毒冰，快喝的人摄入了毒，慢喝的人没事。' }, { roundId });
const solveTurnId = dataOf(solveResponse).turnId;
const solveFrame = await waitForTurnResult(guestRealtime, solveTurnId, 'solve turn.completed (真实 Jev)');
check('还原判定返回稳定枚举', ['solved', 'close', 'not_yet', 'uncertain'].includes(solveFrame.payload?.result ?? ''), JSON.stringify(solveFrame.payload));

console.log('== 8. 提前看答案应被拒绝，公布后可读 ==');
const earlyAnswer = await http(`/rounds/${roundId}/answer`, { cookie: guestCookie });
check('未揭晓时答案接口拒绝', earlyAnswer.status === 403, `status=${earlyAnswer.status}`);

await command(hostCookie, roomId, 'reveal_answer', {}, { expectedControlVersion: controlVersion + 2 });
const endedEvent = await guestRealtime.waitFor((f) => f.type === 'round.ended', 'round.ended');
check('两端收到本局结束事件（revealed）', endedEvent.payload.status === 'revealed');

const answerResponse = await http(`/rounds/${roundId}/answer`, { cookie: guestCookie });
check('参与者揭晓后读取汤底', answerResponse.status === 200 && typeof dataOf(answerResponse)?.answer === 'string');

console.log('== 9. 同房间第二局不重复扣次 ==');
const select2 = await command(hostCookie, roomId, 'select_puzzle', { puzzleId: puzzle.id, language: 'zh' }, { expectedControlVersion: controlVersion + 3 });
const start2 = await command(hostCookie, roomId, 'start_round', {}, { expectedControlVersion: dataOf(select2).controlVersion });
check('第二局开局成功', start2.status === 202);
const secondRoundEvent = await guestRealtime.waitFor((f) => f.type === 'round.started' && f.payload.roundId !== roundId, 'round2 started');
check('客人实时收到第二局开局', Boolean(secondRoundEvent.payload.roundId));

const ledgerAfter = await query('select count(*)::int as n from room_credit_ledger where room_id = $1', [roomId]);
check('同房换局不新增账本流水（仍为 2 条）', ledgerAfter[0]?.n === 2, `n=${ledgerAfter[0]?.n}`);

console.log('== 10. 房主关闭房间 ==');
const closeResponse = await command(hostCookie, roomId, 'close_room', {}, { expectedControlVersion: dataOf(start2).controlVersion });
check('关闭房间命令受理', closeResponse.status === 202 && dataOf(closeResponse).status === 'accepted');
const closedEvent = await guestRealtime.waitFor((f) => f.type === 'room.closed', 'room.closed');
check('客人实时收到关闭事件', closedEvent.payload.reason === 'by_host');

const roomRow = await query('select status, close_reason from rooms where id = $1', [roomId]);
check('房间终态 closed', roomRow[0]?.status === 'closed' && roomRow[0]?.close_reason === 'by_host');
const activeRow = await query('select count(*)::int as n from active_room_users where room_id = $1', [roomId]);
check('进行中标记清空', activeRow[0]?.n === 0);

console.log(`\n断言通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项：${failures.join('；')}` : ''}`);
hostRealtime.ws.close();
guestRealtime.ws.close();
await pool.end();
process.exit(failures.length ? 1 : 0);
