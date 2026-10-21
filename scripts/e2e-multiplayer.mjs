/**
 * 双用户多人房间端到端联调（真实进程 + 真实数据库 + 真实 WebSocket + 真实 Jev）：
 *   用户 A（房主）：注册 → 会客厅 → 邀请 → 选题 → 开局 → 提示 → 讨论 → 公布答案 → 再来一题（新房迁移）→ 关新房
 *   用户 B（客人）：注册 → 会客厅加入 → 提问（真实 Jev 判定）→ 还原 → 晚加入 → 被迁入新房 → 独立消费
 *   用户 C（客人二）：晚加入进行中的局 → 被踢 → 实时断开与写权限拒绝 → 不随新房迁移
 * 校验：事件同步一致性、免费账本 reserve→consume 唯一流水、一房一题（旧房锁死 + 新房独立计数）、
 *       一键迁移（幂等、被踢不迁移）、踢人实时断开、jev_calls 落库、汤底仅揭晓后可读。
 * 运行：cd apps/api && node ../../scripts/e2e-multiplayer.mjs
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

// ============================================================

const HOST = `host-${Date.now()}@e2e.test`;
const GUEST = `guest-${Date.now()}@e2e.test`;
const GUEST2 = `guest2-${Date.now()}@e2e.test`;

console.log('== 1. 多用户邮箱验证码注册登录（真实 SMTP 收信台）==');
const hostCookie = await register(HOST, '房主甲');
const guestCookie = await register(GUEST, '客人乙');
const guest2Cookie = await register(GUEST2, '客人丙');
check('房主登录成功', hostCookie.length > 0);
check('客人登录成功', guestCookie.length > 0);
check('客人二登录成功', guest2Cookie.length > 0);

const hostMe = dataOf(await http('/me', { cookie: hostCookie }));
const guestMe = dataOf(await http('/me', { cookie: guestCookie }));
const guest2Me = dataOf(await http('/me', { cookie: guest2Cookie }));
check('免费开房账户初始化为 10/0/0', hostMe.freeRooms.total === 10 && hostMe.freeRooms.consumed === 0 && hostMe.freeRooms.reserved === 0, JSON.stringify(hostMe.freeRooms));

// 新用户带一个月注册礼赞助，开房会走赞助授权（免费次数不动）。
// 本剧本要覆盖「免费次数预留 → 首次有效判定消费」这条账本路径，
// 因此显式冻结房主的注册礼（不删行：sponsor_ledger 引用了它）；客人保留注册礼，后文验证赞助授权分支。
await query(`update sponsor_grants set status = 'frozen', effective_until = now() - interval '1 day' where user_id = $1 and type = 'signup_bonus'`, [hostMe.userId]);
const guestGrant = await query(`select type, status from sponsor_grants where user_id = $1 and type = 'signup_bonus'`, [guestMe.userId]);
check('新用户带注册礼赞助（客人账号保留）', guestGrant.length === 1 && guestGrant[0].status === 'active');

console.log('== 2. 房主开房：会客厅 → 邀请 → 客人加入 → 选题 → 开局（预留免费次数）==');
const lobby = dataOf(await http('/lobbies', { method: 'POST', cookie: hostCookie, body: { capacity: 8 } }));
check('拿到会客厅', Boolean(lobby.lobbyId));
const lobbyInvite = dataOf(await http(`/lobbies/${lobby.lobbyId}/invite`, { method: 'POST', cookie: hostCookie }));
check('会客厅邀请令牌已签发', Boolean(lobbyInvite.token));
const guestJoin = await http('/lobbies/join', { method: 'POST', cookie: guestCookie, body: { token: lobbyInvite.token } });
check('客人凭邀请加入会客厅', guestJoin.status === 202, `status=${guestJoin.status}`);

const catalog = dataOf(await http('/puzzles?language=zh&limit=50'));
const puzzle = catalog.items.find((p) => p.legacyId === 'seed-classic-iced-drinks') ?? catalog.items[0];
check('题库有可用题目', Boolean(puzzle?.id));
const selectResponse = await http(`/lobbies/${lobby.lobbyId}/select`, { method: 'POST', cookie: hostCookie, body: { puzzleId: puzzle.id, language: 'zh' } });
check('房主选题受理', selectResponse.status === 202);
const startResponse = dataOf(await http(`/lobbies/${lobby.lobbyId}/start`, { method: 'POST', cookie: hostCookie }));
const roomId = startResponse.roomId;
const inviteToken = startResponse.inviteToken;
check('开局成功并拿到房间与邀请令牌', Boolean(roomId) && Boolean(inviteToken));

const hostRealtime = await connectRealtime(hostCookie, roomId, 0);
check('房主 WS 快照握手 sync.ready', hostRealtime.frames.some((f) => f.type === 'sync.ready'));

const reserved = await query('select consumed, reserved from free_room_accounts where user_id = $1', [hostMe.userId]);
check('开局后预留 1 次（consumed=0, reserved=1）', reserved[0]?.consumed === 0 && reserved[0]?.reserved === 1, JSON.stringify(reserved[0]));
const entitlement = await query('select source, status from room_entitlements where room_id = $1', [roomId]);
check('无赞助时开房授权来自免费次数', entitlement[0]?.source === 'free' && entitlement[0]?.status === 'reserved', JSON.stringify(entitlement[0]));

const openedSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: hostCookie }));
check('开局房间直接是 playing 且有一局', openedSnapshot.roomStatus === 'playing' && Boolean(openedSnapshot.round), JSON.stringify({ status: openedSnapshot.roomStatus }));
check('会客厅成员随开局迁入房间', openedSnapshot.members.length === 2, `members=${openedSnapshot.members.length}`);
check('房间默认由 Jev 主持', openedSnapshot.hostMode === 'ai' && openedSnapshot.userHostId === null, JSON.stringify({ hostMode: openedSnapshot.hostMode, userHostId: openedSnapshot.userHostId }));

console.log('== 3. 客人实时订阅：补齐开局前的全部事件 ==');
const guestRealtime = await connectRealtime(guestCookie, roomId, 0);
const guestSnapshotEvents = guestRealtime.frames.filter((f) => f.type !== 'ack' && f.type !== 'sync.ready' && f.type !== 'heartbeat');
check('客人补齐了加入前的全部事件（round.started 等）', guestSnapshotEvents.some((f) => f.type === 'round.started'));

console.log('== 3b. 客人二晚加入进行中的局（房间邀请链接）==');
const guest2Join = await http('/rooms/join', { method: 'POST', cookie: guest2Cookie, body: { token: inviteToken } });
check('客人二凭房间邀请晚加入', guest2Join.status === 202, `status=${guest2Join.status}`);
await hostRealtime.waitFor((f) => f.type === 'room.member_joined' && f.payload.nickname === '客人丙', 'member_joined');
check('房主实时收到晚加入成员事件', true);
const guest2Realtime = await connectRealtime(guest2Cookie, roomId, 0);
check('客人二实时订阅就绪', guest2Realtime.frames.some((f) => f.type === 'sync.ready'));

console.log('== 4. 客人提问 → 真实 Jev 判定 ==');
const askResponse = await command(guestCookie, roomId, 'ask', { text: '冰块本身有毒吗？' }, { roundId: openedSnapshot.round.roundId });
check('提问受理 202', askResponse.status === 202);
const turnId = dataOf(askResponse).turnId;
const acceptedSeq = dataOf(askResponse).acceptedSeq;
check('返回问答编号与事件序号', Boolean(turnId) && Number.isInteger(acceptedSeq));

await hostRealtime.waitFor((f) => f.type === 'turn.accepted' && f.payload?.turnId === turnId, 'host sees turn.accepted');
check('房主实时看到客人提问', true);

const completedFrame = await waitForTurnResult(guestRealtime, turnId, 'turn.completed (真实 Jev)');
check('真实 Jev 判定返回（turn.completed）', completedFrame.type === 'turn.completed', completedFrame.type);
check('判定是稳定枚举', ['yes', 'no', 'irrelevant', 'uncertain'].includes(completedFrame.payload.result), completedFrame.payload.result);
check('实时判定携带真实置信度', typeof completedFrame.payload.confidence === 'number' && completedFrame.payload.confidence >= 0 && completedFrame.payload.confidence <= 1);
check('判定来源标记为 ai', completedFrame.payload.source === 'ai' || completedFrame.payload.source === undefined, JSON.stringify(completedFrame.payload));
const confidenceSnapshot = dataOf(await http(`/rooms/${roomId}/snapshot`, { cookie: guestCookie }));
check('刷新快照保留同一置信度', confidenceSnapshot.turns.find((turn) => turn.turnId === turnId)?.confidence === completedFrame.payload.confidence);
await hostRealtime.waitFor((f) => f.type === 'turn.completed' && f.payload?.turnId === turnId, 'host sees completed');
check('两端收到同一条判定的同一编号', true);

const calls = await query('select status, choice, confidence, error_class from jev_calls where turn_id = $1 order by attempt', [turnId]);
check('jev_calls 落库（真实调用记录）', calls.length >= 1 && calls[0].status === 'ok', JSON.stringify(calls));
check('公开置信度与模型调用记录一致', Number(calls.at(-1)?.confidence) === completedFrame.payload.confidence);

const afterFirst = await query('select consumed, reserved from free_room_accounts where user_id = $1', [hostMe.userId]);
check('首次有效判定消费免费次数（reserved 1→0, consumed 0→1）', afterFirst[0]?.consumed === 1 && afterFirst[0]?.reserved === 0, JSON.stringify(afterFirst[0]));
const ledger = await query("select action from room_credit_ledger where room_id = $1 order by action", [roomId]);
check('账本恰好一条 reserve + 一条 consume', ledger.length === 2 && ledger.some((l) => l.action === 'reserve') && ledger.some((l) => l.action === 'consume'), JSON.stringify(ledger));
const consumedEntitlement = await query('select source, status from room_entitlements where room_id = $1', [roomId]);
check('首次有效判定后免费授权转 consumed', consumedEntitlement[0]?.status === 'consumed', JSON.stringify(consumedEntitlement[0]));

console.log('== 5. 房主解锁提示、双方讨论 ==');
const hintResponse = await command(hostCookie, roomId, 'reveal_hint', {}, { expectedControlVersion: 0 });
check('提示命令受理且控制版本推进到 1', hintResponse.status === 202 && dataOf(hintResponse).controlVersion === 1, JSON.stringify(dataOf(hintResponse)));
const hintEvent = await guestRealtime.waitFor((f) => f.type === 'hint.revealed', 'hint.revealed');
check('客人实时收到提示事件', typeof hintEvent.payload.text === 'string' && hintEvent.payload.index === 0);

await command(guestCookie, roomId, 'discussion', { text: '我怀疑毒在茶里，不在冰块里。' }, { roundId: openedSnapshot.round.roundId });
await hostRealtime.waitFor((f) => f.type === 'discussion.created', 'discussion.created');
check('房主实时收到讨论消息', true);

console.log('== 6. 客人还原（第二次真实 Jev 判定）==');
const solveResponse = await command(guestCookie, roomId, 'solve', { text: '毒被放在慢喝的人的杯子里，或者热茶融化毒冰，快喝的人摄入了毒，慢喝的人没事。' }, { roundId: openedSnapshot.round.roundId });
const solveTurnId = dataOf(solveResponse).turnId;
const solveFrame = await waitForTurnResult(guestRealtime, solveTurnId, 'solve turn.completed (真实 Jev)');
check('还原判定返回稳定枚举', ['solved', 'close', 'not_yet', 'uncertain'].includes(solveFrame.payload?.result ?? ''), JSON.stringify(solveFrame.payload));

console.log('== 6b. 踢出保持连接的成员（R06：实时立即断开、写与补齐拒绝）==');
const kick2 = await command(hostCookie, roomId, 'kick', { userId: guest2Me.userId }, { expectedControlVersion: 1 });
check('踢人命令受理', kick2.status === 202 && dataOf(kick2).status === 'accepted');
const guest2Disconnected = await new Promise((resolve) => {
  if (guest2Realtime.ws.readyState > 1) return resolve(true);
  guest2Realtime.ws.once('close', () => resolve(true));
  setTimeout(() => resolve(false), 10_000);
});
check('被踢成员的实时连接被服务端断开', guest2Disconnected);
const kickedAsk = await command(guest2Cookie, roomId, 'ask', { text: '被踢之后还能提问吗？' }, { roundId: openedSnapshot.round.roundId });
check('被踢成员写接口拒绝', kickedAsk.status === 403, `status=${kickedAsk.status}`);
const kickedEvents = await http(`/rooms/${roomId}/events?afterSeq=0`, { cookie: guest2Cookie });
check('被踢成员补齐接口拒绝', kickedEvents.status === 403, `status=${kickedEvents.status}`);
const kickedSnapshot = await http(`/rooms/${roomId}/snapshot`, { cookie: guest2Cookie });
check('被踢成员快照拒绝', kickedSnapshot.status === 403, `status=${kickedSnapshot.status}`);

console.log('== 7. 提前看答案应被拒绝，公布后可读 ==');
const earlyAnswer = await http(`/rounds/${openedSnapshot.round.roundId}/answer`, { cookie: guestCookie });
check('未揭晓时答案接口拒绝', earlyAnswer.status === 403, `status=${earlyAnswer.status}`);
const hostSecret = await http(`/rounds/${openedSnapshot.round.roundId}/host-view`, { cookie: guestCookie });
check('普通玩家读主持人汤底接口被拒', hostSecret.status === 403, `status=${hostSecret.status}`);

// 控制版本：开局为 0；解锁提示 → 1；踢人 → 2（控制命令逐个推进）
await command(hostCookie, roomId, 'reveal_answer', {}, { expectedControlVersion: 2 });
const endedEvent = await guestRealtime.waitFor((f) => f.type === 'round.ended', 'round.ended');
check('两端收到本局结束事件（revealed）', endedEvent.payload.status === 'revealed');
const closedEvent = await guestRealtime.waitFor((f) => f.type === 'room.closed', 'room.closed (一房一题归档)');
check('公布答案后房间归档（round_ended）', closedEvent.payload.reason === 'round_ended');

const answerResponse = await http(`/rounds/${openedSnapshot.round.roundId}/answer`, { cookie: guestCookie });
check('参与者揭晓后读取汤底', answerResponse.status === 200 && typeof dataOf(answerResponse)?.answer === 'string');

const roomAfterReveal = await query('select status, close_reason from rooms where id = $1', [roomId]);
check('旧房终态 closed / round_ended', roomAfterReveal[0]?.status === 'closed' && roomAfterReveal[0]?.close_reason === 'round_ended', JSON.stringify(roomAfterReveal[0]));
const activeRooms = dataOf(await http('/me/active-rooms', { cookie: guestCookie }));
check('归档后不再出现在进行中房间列表', !activeRooms.rooms.some((r) => r.roomId === roomId), JSON.stringify(activeRooms));
const rejoinOld = await http('/rooms/join', { method: 'POST', cookie: guest2Cookie, body: { token: inviteToken } });
check('旧房邀请无法再加入', rejoinOld.status === 409, `status=${rejoinOld.status}`);

console.log('== 8. 一房一题：旧房锁死，再来一题创建独立新房 ==');
const lockedCommand = await command(hostCookie, roomId, 'ask', { text: '旧房还能提问吗？' }, { roundId: openedSnapshot.round.roundId });
check('归档房间拒绝任何新命令', lockedCommand.status === 409 && errorOf(lockedCommand).code === 'ROOM_CLOSED', JSON.stringify(errorOf(lockedCommand)));

const followupResponse = await http('/rooms/followup', {
  method: 'POST',
  cookie: hostCookie,
  body: { sourceRoomId: roomId, puzzleId: puzzle.id, language: 'zh' },
});
check('房主发起再来一题受理', followupResponse.status === 202, JSON.stringify(followupResponse.body));
const followup = dataOf(followupResponse);
check('新房创建（新 roomId）', Boolean(followup.targetRoomId) && followup.targetRoomId !== roomId);
check('新房邀请令牌签发', Boolean(followup.inviteToken));
const migratedGuest = followup.members.find((m) => m.userId === guestMe.userId);
check('客人被迁入新房', migratedGuest?.migrated === true, JSON.stringify(followup.members));
check('被踢成员不迁移', !followup.members.some((m) => m.userId === guest2Me.userId), JSON.stringify(followup.members));

const followupRepeat = await http('/rooms/followup', {
  method: 'POST',
  cookie: hostCookie,
  body: { sourceRoomId: roomId, puzzleId: catalog.items[1]?.id ?? puzzle.id, language: 'zh' },
});
check('重复请求返回同一目标房（不重复建房/扣次）', followupRepeat.status === 202 && dataOf(followupRepeat).targetRoomId === followup.targetRoomId && dataOf(followupRepeat).existing === true);

const followupEvent = await guestRealtime.waitFor((f) => f.type === 'room.followup_created', 'room.followup_created');
check('旧房成员实时收到新房入口', followupEvent.payload.targetRoomId === followup.targetRoomId);

const followupRow = await query('select target_room_id, initiated_by from room_followups where source_room_id = $1', [roomId]);
check('续玩关系落库且唯一', followupRow.length === 1 && followupRow[0].target_room_id === followup.targetRoomId);

const newRoomRow = await query('select status, host_user_id from rooms where id = $1', [followup.targetRoomId]);
check('新房直接进入 playing 且房主保持', newRoomRow[0]?.status === 'playing' && newRoomRow[0]?.host_user_id === hostMe.userId);

console.log('== 9. 新房独立游玩与独立计费 ==');
const guestNewRealtime = await connectRealtime(guestCookie, followup.targetRoomId, 0);
check('客人订阅新房并完成握手', guestNewRealtime.frames.some((f) => f.type === 'sync.ready'));
const newRoomAsk = await command(guestCookie, followup.targetRoomId, 'ask', { text: '这和上一题无关，是新的题目对吗？' });
check('新房内客人提问受理', newRoomAsk.status === 202);
const newTurnId = dataOf(newRoomAsk).turnId;
const newCompleted = await waitForTurnResult(guestNewRealtime, newTurnId, '新房 turn.completed (真实 Jev)');
check('新房首个有效判定完成', newCompleted.type === 'turn.completed', newCompleted.type);

const afterFollowup = await query('select consumed, reserved from free_room_accounts where user_id = $1', [hostMe.userId]);
check('新房首次判定再次消费（consumed 1→2）', afterFollowup[0]?.consumed === 2 && afterFollowup[0]?.reserved === 0, JSON.stringify(afterFollowup[0]));
const oldLedger = await query('select count(*)::int as n from room_credit_ledger where room_id = $1', [roomId]);
const newLedger = await query("select action from room_credit_ledger where room_id = $1 order by action", [followup.targetRoomId]);
check('旧房账本仍为 2 条、新房独立 reserve+consume', oldLedger[0]?.n === 2 && newLedger.length === 2 && newLedger.some((l) => l.action === 'reserve') && newLedger.some((l) => l.action === 'consume'), JSON.stringify({ old: oldLedger[0], new: newLedger }));

console.log('== 9b. 注册礼账号开房走赞助授权：免费次数不动 ==');
const guestLobby = dataOf(await http('/lobbies', { method: 'POST', cookie: guestCookie, body: { capacity: 8 } }));
const guestLobbyInvite = dataOf(await http(`/lobbies/${guestLobby.lobbyId}/invite`, { method: 'POST', cookie: guestCookie }));
await http('/lobbies/join', { method: 'POST', cookie: guest2Cookie, body: { token: guestLobbyInvite.token } });
await http(`/lobbies/${guestLobby.lobbyId}/select`, { method: 'POST', cookie: guestCookie, body: { puzzleId: puzzle.id, language: 'zh' } });
const guestRoom = dataOf(await http(`/lobbies/${guestLobby.lobbyId}/start`, { method: 'POST', cookie: guestCookie }));
check('客人自己的房间开局成功', Boolean(guestRoom?.roomId));
const guestEntitlement = await query('select source, status from room_entitlements where room_id = $1', [guestRoom.roomId]);
check('有赞助时开房走赞助授权', guestEntitlement[0]?.source === 'sponsorship', JSON.stringify(guestEntitlement[0]));
const guestFree = await query('select consumed, reserved from free_room_accounts where user_id = $1', [guestMe.userId]);
check('赞助账号的免费次数保持 10/0/0', guestFree[0]?.consumed === 0 && guestFree[0]?.reserved === 0, JSON.stringify(guestFree[0]));

console.log('== 10. 房主主动关闭新房（明确终止操作）==');const closeNew = await command(hostCookie, followup.targetRoomId, 'close_room');
check('新房关闭命令受理', closeNew.status === 202);
const newClosedEvent = await guestNewRealtime.waitFor((f) => f.type === 'room.closed', '新房 room.closed');
check('新房成员收到关闭事件（by_host）', newClosedEvent.payload.reason === 'by_host');
const newRoomFinal = await query('select status, close_reason from rooms where id = $1', [followup.targetRoomId]);
check('新房终态 closed / by_host', newRoomFinal[0]?.status === 'closed' && newRoomFinal[0]?.close_reason === 'by_host', JSON.stringify(newRoomFinal[0]));
const newRoundFinal = await query('select status, end_reason from rounds where room_id = $1', [followup.targetRoomId]);
check('解散正在游戏的房间时局同步置为 aborted', newRoundFinal[0]?.status === 'abandoned' || newRoundFinal[0]?.status === 'aborted', JSON.stringify(newRoundFinal[0]));

hostRealtime.ws.close();
guestRealtime.ws.close();
guestNewRealtime.ws.close();
await pool.end();
summary();
