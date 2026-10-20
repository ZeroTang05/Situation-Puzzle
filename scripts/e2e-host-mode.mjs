/**
 * 用户主持人模式端到端验证（真实进程 + 真实数据库 + 真实 WebSocket + 真实 jobs）：
 *   房主 A：登录 → 会客厅 → 选题 → 开局 → 审核主持申请 → 房主自申请直接通过
 *   主持人 B：登录 → 加入会客厅 → 申请成为主持人 → 接管判题 → 回答玩家提问 → 查看汤底 → 退出
 *   玩家 C：登录 → 加入会客厅 → 提问（挂起等待主持人）→ 收到主持人的判定 → 退出后由 Jev 接管
 *
 * 校验：主持形态切换、提问挂起不进 AI 队列（jev_calls 无记录）、主持人判定广播、
 *       汤底仅主持人可读、退出主持人后挂起提问交还 Jev。
 * 运行：node scripts/e2e-host-mode.mjs（需先起 API :8080、jobs 与 SMTP 收信台）
 */
import { requireFromApi, STEP_TIMEOUT, check, summary, http, dataOf, errorOf, register, connectRealtime, waitForTurnResult } from './e2e-lib.mjs';

const pg = requireFromApi('pg');
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://jev:jev@localhost:54339/jev';

async function command(cookie, roomId, type, payload = {}, extra = {}) {
  return http(`/rooms/${roomId}/commands`, {
    method: 'POST',
    cookie,
    body: { clientRequestId: crypto.randomUUID(), type, payload, ...extra },
  });
}

const pool = new pg.Pool({ connectionString: DB_URL });
async function query(text, values) {
  const result = await pool.query(text, values);
  return result.rows;
}

const OWNER = `owner-${Date.now()}@e2e.test`;
const HOSTER = `hoster-${Date.now()}@e2e.test`;
const PLAYER = `player-${Date.now()}@e2e.test`;

console.log('== 1. 三人注册并登录（真实 SMTP 收信台）==');
const ownerCookie = await register(OWNER, '房主');
const hosterCookie = await register(HOSTER, '主持人');
const playerCookie = await register(PLAYER, '玩家');
check('房主登录成功', ownerCookie.length > 0);
check('主持人登录成功', hosterCookie.length > 0);
check('玩家登录成功', playerCookie.length > 0);

const ownerMe = dataOf(await http('/me', { cookie: ownerCookie }));
const hosterMe = dataOf(await http('/me', { cookie: hosterCookie }));
const playerMe = dataOf(await http('/me', { cookie: playerCookie }));

console.log('== 2. 会客厅组队 → 选题 → 开局 ==');
const lobby = dataOf(await http('/lobbies', { method: 'POST', cookie: ownerCookie, body: { capacity: 8 } }));
check('拿到会客厅', Boolean(lobby.lobbyId));
const lobbyInvite = dataOf(await http(`/lobbies/${lobby.lobbyId}/invite`, { method: 'POST', cookie: ownerCookie }));
check('会客厅邀请令牌已签发', Boolean(lobbyInvite.token));
const hosterJoin = await http('/lobbies/join', { method: 'POST', cookie: hosterCookie, body: { token: lobbyInvite.token } });
const playerJoin = await http('/lobbies/join', { method: 'POST', cookie: playerCookie, body: { token: lobbyInvite.token } });
check('主持人与玩家加入会客厅', hosterJoin.status === 202 && playerJoin.status === 202);

const catalog = dataOf(await http('/puzzles?language=zh&limit=50'));
const puzzle = catalog.items[0];
check('题库有可用题目', Boolean(puzzle?.id));
const selectResponse = await http(`/lobbies/${lobby.lobbyId}/select`, { method: 'POST', cookie: ownerCookie, body: { puzzleId: puzzle.id, language: 'zh' } });
check('房主选题受理', selectResponse.status === 202);
const startResponse = dataOf(await http(`/lobbies/${lobby.lobbyId}/start`, { method: 'POST', cookie: ownerCookie }));
const roomId = startResponse.roomId;
check('开局成功并拿到房间', Boolean(roomId));

const roomSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: ownerCookie }));
const roundId = roomSnapshot.round.roundId;
check('房间默认是 AI 主持', roomSnapshot.hostMode === 'ai' && roomSnapshot.userHostId === null, JSON.stringify({ hostMode: roomSnapshot.hostMode, userHostId: roomSnapshot.userHostId }));
check('开局时成员已随会客厅迁入', roomSnapshot.members.length === 3, `members=${roomSnapshot.members.length}`);

const hosterRealtime = await connectRealtime(hosterCookie, roomId, 0);
const playerRealtime = await connectRealtime(playerCookie, roomId, 0);
check('主持人与玩家实时订阅就绪', hosterRealtime.frames.some((f) => f.type === 'sync.ready') && playerRealtime.frames.some((f) => f.type === 'sync.ready'));

console.log('== 3. 申请成为主持人 → 房主审核 ==');
const requestResponse = await command(hosterCookie, roomId, 'request_host');
check('申请受理', requestResponse.status === 202 && dataOf(requestResponse).status === 'accepted');
const requestedEvent = await hosterRealtime.waitFor((f) => f.type === 'room.host_requested' && f.payload.userId === hosterMe.userId, 'room.host_requested');
check('申请事件广播给房间', Boolean(requestedEvent));

const pendingSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: ownerCookie }));
check('房主快照看到待审申请', pendingSnapshot.hostRequests.some((r) => r.userId === hosterMe.userId), JSON.stringify(pendingSnapshot.hostRequests));

const nonOwnerApprove = await command(playerCookie, roomId, 'approve_host', { userId: hosterMe.userId });
check('非房主不能审核申请', nonOwnerApprove.status === 403, `status=${nonOwnerApprove.status}`);

const approveResponse = await command(ownerCookie, roomId, 'approve_host', { userId: hosterMe.userId });
check('房主批准受理', approveResponse.status === 202 && dataOf(approveResponse).status === 'accepted');
await hosterRealtime.waitFor((f) => f.type === 'room.host_approved' && f.payload.userId === hosterMe.userId, 'room.host_approved');
const hostedSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: playerCookie }));
check('房间切换为用户主持', hostedSnapshot.hostMode === 'user' && hostedSnapshot.userHostId === hosterMe.userId, JSON.stringify({ hostMode: hostedSnapshot.hostMode, userHostId: hostedSnapshot.userHostId }));
check('成员列表标记用户主持人', hostedSnapshot.members.find((m) => m.userId === hosterMe.userId)?.isUserHost === true);

console.log('== 4. 用户主持模式：提问挂起，不进 AI 队列 ==');
const askResponse = await command(playerCookie, roomId, 'ask', { text: '他是凶手吗？' }, { roundId });
check('提问受理', askResponse.status === 202);
const heldTurnId = dataOf(askResponse).turnId;
await new Promise((r) => setTimeout(r, 3000));
const heldTurn = (await query('select status, result, judged_by, deadline_at from turns where id = $1', [heldTurnId]))[0];
check('提问保持挂起（queued）', heldTurn.status === 'queued', JSON.stringify(heldTurn));
check('挂起任务没有 deadline（不参与排队超时）', heldTurn.deadline_at === null);
const heldCalls = await query('select id from jev_calls where turn_id = $1', [heldTurnId]);
check('Jev 没有被调用（jev_calls 无记录）', heldCalls.length === 0);

console.log('== 5. 主持人回答玩家提问 ==');
const forbiddenAnswer = await command(playerCookie, roomId, 'host_answer', { turnId: heldTurnId, verdict: 'yes' }, { roundId });
check('非主持人不能回答', forbiddenAnswer.status === 403, `status=${forbiddenAnswer.status}`);
const answerResponse = await command(hosterCookie, roomId, 'host_answer', { turnId: heldTurnId, verdict: 'yes' }, { roundId });
check('主持人判定受理', answerResponse.status === 202);
const answeredFrame = await waitForTurnResult(playerRealtime, heldTurnId, '玩家收到主持人判定');
check('玩家实时收到 turn.completed', answeredFrame.type === 'turn.completed', answeredFrame.type);
check('判定值来自主持人', answeredFrame.payload.result === 'yes' && answeredFrame.payload.source === 'host', JSON.stringify(answeredFrame.payload));
const answeredTurn = (await query('select status, result, judged_by from turns where id = $1', [heldTurnId]))[0];
check('判定落库并标记来源为 host', answeredTurn.status === 'succeeded' && answeredTurn.result === 'yes' && answeredTurn.judged_by === 'host', JSON.stringify(answeredTurn));

console.log('== 6. 汤底：只有主持人可读 ==');
const hostView = await http(`/rounds/${roundId}/host-view`, { cookie: hosterCookie });
check('主持人读到汤底', hostView.status === 200 && typeof dataOf(hostView).answer === 'string', JSON.stringify(hostView.body));
const playerView = await http(`/rounds/${roundId}/host-view`, { cookie: playerCookie });
check('普通玩家读汤底被拒', playerView.status === 403 && errorOf(playerView).code === 'FORBIDDEN', `status=${playerView.status}`);
const snapshotAnswerLeak = JSON.stringify(dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: playerCookie })));
check('快照里不含汤底', !snapshotAnswerLeak.includes(dataOf(hostView).answer));

console.log('== 7. 主持人退出 → 提问交还 Jev ==');
const secondAsk = await command(playerCookie, roomId, 'ask', { text: '还有别人在场吗？' }, { roundId });
const secondTurnId = dataOf(secondAsk).turnId;
check('退出前的新提问受理', secondAsk.status === 202);
const resignResponse = await command(hosterCookie, roomId, 'resign_host');
check('主持人退出受理', resignResponse.status === 202);
await playerRealtime.waitFor((f) => f.type === 'room.host_resigned' && f.payload.userId === hosterMe.userId, 'room.host_resigned');
const resignedSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: playerCookie }));
check('房间回到 AI 主持', resignedSnapshot.hostMode === 'ai' && resignedSnapshot.userHostId === null, JSON.stringify({ hostMode: resignedSnapshot.hostMode, userHostId: resignedSnapshot.userHostId }));
const hostViewAfter = await http(`/rounds/${roundId}/host-view`, { cookie: hosterCookie });
check('退出后主持人不能再读汤底', hostViewAfter.status === 403);

const jevFrame = await waitForTurnResult(playerRealtime, secondTurnId, '挂起提问交还 Jev 判定');
check('挂起的提问由 Jev 判定完成', jevFrame.type === 'turn.completed', jevFrame.type);
const jevTurn = (await query('select status, result, judged_by from turns where id = $1', [secondTurnId]))[0];
check('判定来源标记为 ai', jevTurn.judged_by === 'ai', JSON.stringify(jevTurn));
const jevCalls = await query('select id from jev_calls where turn_id = $1', [secondTurnId]);
check('Jev 真实调用已记录', jevCalls.length >= 1);

console.log('== 8. 房主自己申请直接通过 ==');
const ownerApply = await command(ownerCookie, roomId, 'request_host');
check('房主自申请受理', ownerApply.status === 202);
const ownerSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: ownerCookie }));
check('房主直接成为用户主持人', ownerSnapshot.hostMode === 'user' && ownerSnapshot.userHostId === ownerMe.userId, JSON.stringify({ hostMode: ownerSnapshot.hostMode, userHostId: ownerSnapshot.userHostId }));

await pool.end();
summary();
