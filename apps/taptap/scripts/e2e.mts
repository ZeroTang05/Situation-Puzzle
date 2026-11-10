/**
 * 原生端使用的真实业务链路验证：真实 HTTP、PostgreSQL、SMTP 与既有题库。
 * 这份脚本验证接口权限和流程；画布、键盘、平台成功登录仍由 TapTap 真机验收。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  authSessionSchema, meResponseSchema, lobbyCreateResponseSchema, lobbySnapshotSchema,
  lobbyStartResponseSchema, roomSnapshotSchema, roomCommandResponseSchema, friendSearchResponseSchema,
  friendRequestListResponseSchema, friendListResponseSchema, dmMessageListResponseSchema,
  notificationListResponseSchema, creationDetailSchema, creationPreviewSchema, myRatingSchema,
  deviceAuthorizationSchema, deviceVerificationSchema, deviceTokenSchema,
  creationCompleteSchema, selectUnplayedPuzzle, canRateRoomPuzzle, soloJudgeResponseSchema, errorBodySchema,
} from '@jev/contracts';
import { z } from 'zod';
import { readAllCatalogItems } from '../src/catalogue-pages.js';
import { localCreationSchema, persistCreation, transitionCreation, updateCreationAuthor } from '../src/creation-save.js';
import type { api as NativeApi, RequestOptions } from '../src/api.js';
import { RealtimePeer } from './realtime-peer.mjs';
import { latestOtp } from './smtp-inbox.mjs';
import { parseAuthResult } from '../src/auth-protocol.js';
import { ApiError } from '../src/api-error.js';
import { claimReferral, parseShareScene } from '../src/share-scene.js';
import { hasPendingInput, pendingRoomMessages } from '../src/rooms/message-delivery.js';
import type { PendingCommand } from '../src/rooms/room-local.js';

const origin = process.env.TAPTAP_E2E_API_ORIGIN;
const mailboxFile = process.env.TAPTAP_E2E_MAILBOX;
if (!origin || !mailboxFile) throw new Error('请指定独立联调 API 与真实 SMTP 收信文件');
let checks = 0;
function check(condition: unknown, name: string): asserts condition { assert(condition, name); console.log(`通过：${name}`); checks++; }
type Actor = { token: string; email: string; id: string };

async function raw(path: string, init: { method?: string; body?: unknown; actor?: Actor; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(init.actor && { Authorization: `Bearer ${init.actor.token}` }), ...init.headers },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }), signal: AbortSignal.timeout(60000),
  });
  return { status: response.status, body: await response.json() as unknown };
}
async function call<T>(path: string, schema: z.ZodType<T>, init: Parameters<typeof raw>[1] = {}): Promise<T> {
  const response = await raw(path, init);
  if (response.status < 200 || response.status >= 300) {
    const diagnostic = z.object({ code: z.string().optional(), message: z.string().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() }).parse(response.body);
    throw new Error(`${path}: HTTP ${response.status} ${diagnostic.code ?? diagnostic.error?.code ?? ''} ${diagnostic.message ?? diagnostic.error?.message ?? ''}`);
  }
  check(true, `${init?.method ?? (init?.body ? 'POST' : 'GET')} ${path} 成功`);
  return schema.parse(path.startsWith('/auth/') ? response.body : z.object({ data: z.unknown() }).parse(response.body).data);
}
const anyData = z.unknown();
async function register(label: string): Promise<Actor> {
  const email = `taptap-${randomUUID()}@e2e.test`;
  const since = Date.now();
  await call('/auth/email-otp/send-verification-otp', anyData, { body: { email, type: 'sign-in' }, headers: { 'x-jev-otp-purpose': 'signup' } });
  const otp = await latestOtp(mailboxFile!, email, since);
  check(Boolean(otp), '真实 SMTP 收到注册验证码');
  const password = `Taptap-${randomUUID()}`;
  await call('/auth/sign-up/email', anyData, { body: { email, password, name: label }, headers: { 'x-jev-signup-otp': otp } });
  const login = await call('/auth/sign-in/email', z.object({ token: z.string() }), { body: { email, password } });
  const actor = { token: login.token, email, id: '' };
  const session = await call('/auth/get-session', authSessionSchema, { actor }); check(session?.user.email === email, 'Bearer 会话返回正确账号'); actor.id = session.user.id; return actor;
}

const a = await register('房主'); const b = await register('玩家');
/** 仅替换宿主网络传输，仍调用实际原生业务函数和真实 HTTP API。 */
const sendAs = (actor: Actor): typeof NativeApi => async <T,>(path: string, options: RequestOptions = {}, schema?: z.ZodType<T>): Promise<T> => await call(path, schema ?? z.unknown(), { actor, ...options }) as T;
// 设备授权走真实 HTTP 与数据库；邮箱会话代表已经完成官网登录的账号。
const clientId = 'tapmcmnlmv6v8lx5mb';
const invalidClient = await raw('/auth/device/code', { body: { client_id: 'unknown-client' } });
check(invalidClient.status === 400, '设备授权拒绝未知客户端');
const prebound = await raw('/auth/device/code', { body: { client_id: clientId, user_id: a.id } });
check(prebound.status === 400, '小游戏不能预先指定授权账号');
const device = await call('/auth/device/code', deviceAuthorizationSchema, { body: { client_id: clientId } });
check(device.verification_uri_complete.includes('/device?user_code=') && device.expires_in === 600 && device.interval === 5, '授权地址包含公开确认码并限制十分钟有效期');
const exchange = (deviceCode: string) => raw('/auth/device/token', { body: { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
const protocol = z.object({ error: z.string() });
const pending = await exchange(device.device_code); check(pending.status === 400 && protocol.parse(pending.body).error === 'authorization_pending', '网页确认前无法获得会话');
assert.throws(() => parseAuthResult(pending.status, pending.body, deviceTokenSchema, 'zh'), (error) => error instanceof ApiError && error.code === 'authorization_pending'); check(true, '原生认证解析器识别设备待确认状态');
const early = await exchange(device.device_code); check(early.status === 400 && protocol.parse(early.body).error === 'slow_down', '过快轮询被要求等待');
assert.throws(() => parseAuthResult(early.status, early.body, deviceTokenSchema, 'zh'), (error) => error instanceof ApiError && error.code === 'slow_down'); check(true, '原生认证解析器识别设备轮询过快状态');
const anonymousApproval = await raw('/auth/device/approve', { body: { userCode: device.user_code } }); check(anonymousApproval.status === 401, '匿名请求不能批准登录');
const unclaimed = await raw('/auth/device/approve', { actor: a, body: { userCode: device.user_code } }); check(unclaimed.status === 400, '未查看确认页不能直接批准');
const verified = await call(`/auth/device?user_code=${device.user_code}`, deviceVerificationSchema, { actor: a }); check(verified.client_id === clientId && verified.status === 'pending', '登录后的确认页认领授权请求');
const otherView = await call(`/auth/device?user_code=${device.user_code}`, deviceVerificationSchema, { actor: b }); check(!otherView.client_id, '其他账号无法读取请求详情');
const wrongApproval = await raw('/auth/device/approve', { actor: b, body: { userCode: device.user_code } }); check(wrongApproval.status === 403, '其他账号不能批准此请求');
await call('/auth/device/approve', z.object({ success: z.boolean() }), { actor: a, body: { userCode: device.user_code } });
await new Promise((resolve) => setTimeout(resolve, device.interval * 1000 + 100));
const redeemed = await exchange(device.device_code); check(redeemed.status === 200, '明确批准后能够兑换会话');
const deviceToken = deviceTokenSchema.parse(redeemed.body);
const deviceActor = { ...a, token: deviceToken.access_token };
const deviceSession = await call('/auth/get-session', authSessionSchema, { actor: deviceActor }); check(deviceSession?.user.id === a.id, '授权后的小游戏会话与官网账号一致');
const replay = await exchange(device.device_code); check(replay.status === 400 && protocol.parse(replay.body).error === 'invalid_grant', '兑换过的设备秘密无法重放');
assert.throws(() => parseAuthResult(replay.status, replay.body, deviceTokenSchema, 'zh'), (error) => error instanceof ApiError && error.code === 'invalid_grant'); check(true, '原生认证解析器识别已消费凭证');
await call('/auth/sign-out', anyData, { actor: deviceActor, method: 'POST' });
const deniedDevice = await call('/auth/device/code', deviceAuthorizationSchema, { body: { client_id: clientId } });
await call(`/auth/device?user_code=${deniedDevice.user_code}`, deviceVerificationSchema, { actor: a });
await call('/auth/device/deny', z.object({ success: z.boolean() }), { actor: a, body: { userCode: deniedDevice.user_code } });
const deniedToken = await exchange(deniedDevice.device_code); check(deniedToken.status === 400 && protocol.parse(deniedToken.body).error === 'access_denied', '网页拒绝后不能兑换会话');
assert.throws(() => parseAuthResult(deniedToken.status, deniedToken.body, deviceTokenSchema, 'zh'), (error) => error instanceof ApiError && error.code === 'access_denied'); check(true, '原生认证解析器识别设备拒绝状态');
const unauthorized = await raw('/me'); check(unauthorized.status === 401, '匿名用户无法读取账号');
const invalidLogin = await raw('/auth/taptap-mini/login', { body: { code: 'invalid-code-integration-check' } });
check(invalidLogin.status === 400 && z.object({ code: z.string() }).parse(invalidLogin.body).code === 'TAPTAP_LOGIN_FAILED', '真实 TapTap 拒绝无效临时 code');
const unlinked = await raw('/auth/taptap-mini/link', { body: { code: 'invalid-code-integration-check' } });
check(unlinked.status === 401, '关联 TapTap 账号必须先登录');
const profile = await call('/me', meResponseSchema, { actor: a }); check(profile.userId === a.id && profile.freeRooms.total >= 10, '注册钩子创建开房账户');
const claimantBefore = await call('/me', meResponseSchema, { actor: b });
const referral = parseShareScene({ query: { sceneParam: JSON.stringify({ kind: 'referral', code: profile.invite.code }) } });
check(referral?.kind === 'referral' && referral.code === profile.invite.code, '真实邀请码从原生分享场景完整解析');
const granted = await claimReferral(sendAs(b), referral.code);
check(granted.result === 'granted' && granted.rewardRooms === 5, '原生邀请提交函数通过真实接口为邀请人发五次奖励');
const inviterAfter = await call('/me', meResponseSchema, { actor: a });
check(inviterAfter.freeRooms.total === profile.freeRooms.total + 5 && inviterAfter.invite.invitedCount === profile.invite.invitedCount + 1, '真实账户余额与成功邀请人数同步增加');
const claimantAfter = await call('/me', meResponseSchema, { actor: b });
check(claimantAfter.freeRooms.total === claimantBefore.freeRooms.total, '奖励发给邀请人，被邀请人的额度保持原值');
const repeated = await claimReferral(sendAs(b), referral.code);
check(repeated.result === 'already_claimed' && repeated.rewardRooms === 0, '重复打开同一邀请不会重复发放');
const inviterRepeated = await call('/me', meResponseSchema, { actor: a });
check(inviterRepeated.freeRooms.total === inviterAfter.freeRooms.total && inviterRepeated.invite.invitedCount === inviterAfter.invite.invitedCount, '重复领取后余额与成功邀请人数保持一致');
await assert.rejects(claimReferral(sendAs(a), referral.code), /VALIDATION_FAILED/); check(true, '服务端拒绝邀请人登记自己的邀请码');
assert.throws(() => parseShareScene({ query: { sceneParam: JSON.stringify({ kind: 'referral', code: 'INVALID0' }) } })); check(true, '分享载荷拒绝无效邀请码');
check(parseShareScene({}) === null, '普通启动不登记邀请');
await call('/me/nickname', z.object({ nickname: z.string() }), { actor: a, method: 'PATCH', body: { nickname: '原生端房主' } });

const catalogue = await call('/puzzles?language=zh&page=1&limit=2&sort=popular', z.object({ items: z.array(z.object({ id: z.string(), versionId: z.string() })), total: z.number() }));
check(catalogue.total > 0, '使用现有真实题库'); const puzzleId = catalogue.items[0]!.id;
const allPuzzles = await readAllCatalogItems((cursor) => call(`/puzzles?language=zh&sort=latest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, z.object({ items: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() })));
check(allPuzzles.length === catalogue.total && allPuzzles.length > 100, '原生选题遍历真实完整题库，超过第一页');
const allIds = allPuzzles.map((item) => item.id);
check(selectUnplayedPuzzle(allIds, allIds.slice(0, -1), '', 0) === allIds.at(-1), '完整已玩列表超过五十条时仍只选择未玩作品');
check(selectUnplayedPuzzle(allIds, allIds, '') === null, '当前语言全部玩过时明确返回无新题');

const lobby = await call('/lobbies', lobbyCreateResponseSchema, { actor: a, body: {} });
const lobbyAgain = await call('/lobbies', lobbyCreateResponseSchema, { actor: a, body: {} }); check(lobby.lobbyId === lobbyAgain.lobbyId, '同一账号会客厅固定');
await call(`/lobbies/${lobby.lobbyId}/select`, anyData, { actor: a, body: { puzzleId, language: 'zh' } });
const invitation = await call(`/lobbies/${lobby.lobbyId}/invite`, z.object({ token: z.string() }), { actor: a, method: 'POST' });
const lobbyScene = parseShareScene({ query: { sceneParam: JSON.stringify({ kind: 'lobby', token: invitation.token }) } });
check(lobbyScene?.kind === 'lobby' && lobbyScene.token === invitation.token, '新增好友分享后会客厅邀请仍保留独立类型和真实令牌');
await call('/lobbies/join', anyData, { actor: b, body: { token: invitation.token } });
await call(`/lobbies/${lobby.lobbyId}/host/request`, anyData, { actor: b, method: 'POST' });
await call(`/lobbies/${lobby.lobbyId}/host/approve`, anyData, { actor: a, body: { userId: b.id } });
const snapshot = await call(`/lobbies/${lobby.lobbyId}`, lobbySnapshotSchema, { actor: a }); check(snapshot.hostMode === 'user' && snapshot.userHostId === b.id && snapshot.members.length === 2, '会客厅成员与主持人同步');
const lobbyTicket = await call('/realtime/tickets', z.object({ ticket: z.string() }), { actor: b, method: 'POST' });
const lobbyPeer = await RealtimePeer.connect(origin!, lobbyTicket.ticket);
let started: z.infer<typeof lobbyStartResponseSchema>;
try {
  lobbyPeer.send({ type: 'lobby.subscribe', lobbyId: lobby.lobbyId });
  await lobbyPeer.next((frame) => frame.type === 'ack' && !frame.userId);
  started = await call(`/lobbies/${lobby.lobbyId}/start`, lobbyStartResponseSchema, { actor: a, method: 'POST' });
  const pushed = await lobbyPeer.next((frame) => frame.type === 'lobby.started' && frame.lobbyId === lobby.lobbyId);
  check(pushed.type === 'lobby.started' && pushed.roomId === started.roomId && pushed.inviteToken === started.inviteToken, '真实会客厅连接收到正确开局推送与邀请');
} finally { lobbyPeer.close(); }
let room = await call(`/rooms/${started.roomId}/snapshot`, roomSnapshotSchema, { actor: a }); check(room.hostMode === 'user' && room.members.length === 2, '开局复制成员与主持状态');
const activeRooms = await call('/me/active-rooms', z.object({ rooms: z.array(z.object({ roomId: z.string() })) }), { actor: a }); check(activeRooms.rooms.some((item) => item.roomId === started.roomId), '首页能够读取正在参与的房间');
await call('/rooms/entitlement-preview', z.object({ sponsored: z.boolean(), freeRemaining: z.number() }), { actor: a });
check(!canRateRoomPuzzle(room.round!.status), '进行中的多人局不展示评价');
const hidden = await raw(`/rounds/${room.round!.roundId}/host-view`, { actor: a }); check(hidden.status === 403, '普通玩家无权读取主持人汤底');
const hostView = await call(`/rounds/${room.round!.roundId}/host-view`, z.object({ answer: z.string(), hints: z.array(z.string()) }), { actor: b }); check(hostView.answer.length > 0 && room.round!.answer === null, '主持人私有接口独立返回汤底');
const command = async (actor: Actor, type: string, payload: Record<string, unknown> = {}, id = randomUUID()) => {
  const result = await call(`/rooms/${room.roomId}/commands`, roomCommandResponseSchema, { actor, body: { type, payload, roundId: room.round!.roundId, expectedControlVersion: room.controlVersion, clientRequestId: id } });
  room = await call(`/rooms/${room.roomId}/snapshot`, roomSnapshotSchema, { actor }); return result;
};
const roomTicket = await call('/realtime/tickets', z.object({ ticket: z.string() }), { actor: a, method: 'POST' });
const roomPeer = await RealtimePeer.connect(origin!, roomTicket.ticket); let resumeSeq = room.lastSeq;
try {
  roomPeer.send({ type: 'subscribe', roomId: room.roomId, lastSeq: room.lastSeq });
  const synchronized = await roomPeer.next((frame) => frame.type === 'sync.ready');
  check(synchronized.type === 'sync.ready' && synchronized.watermark >= room.lastSeq, '真实房间连接完成事件水位同步');
  const requestId = randomUUID(); const beforeQuestion = room;
  const sendingQuestion: PendingCommand = { input: { type: 'ask', clientRequestId: requestId, roundId: room.round!.roundId, payload: { text: '故事里有人去世吗？' } }, status: 'sending', retries: 0 };
  check(hasPendingInput([sendingQuestion], 'ask') && !hasPendingInput([sendingQuestion], 'solve'), '未确认提问只暂停同类发送，其他模式仍可输入');
  check(hasPendingInput([{ ...sendingQuestion, status: 'confirming' }], 'ask'), '等待核验的提问继续暂停同类发送');
  const question = await command(a, 'ask', sendingQuestion.input.payload!, requestId);
  const sentQuestion: PendingCommand = { ...sendingQuestion, status: 'sent', result: z.object({ clientRequestId: z.string(), status: z.enum(['accepted', 'duplicate']), controlVersion: z.number(), turnId: z.string() }).parse(question) };
  check(!hasPendingInput([sentQuestion], 'ask'), '真实接口确认后允许发送下一条提问');
  check(pendingRoomMessages([sentQuestion], beforeQuestion, 'qa').length === 1, '真实接口确认与实时消息到达之间保留本地提问');
  check(pendingRoomMessages([sentQuestion], beforeQuestion, 'discuss').length === 0, '本地提问不混入讨论页');
  check(pendingRoomMessages([sentQuestion], room, 'qa').length === 0, '真实权威快照接替本地提问，避免重复显示');
  const accepted = await roomPeer.next((frame) => frame.type === 'turn.accepted');
  if (accepted.type !== 'turn.accepted') throw new Error('缺少真实提问受理事件');
  const acceptedMessage = z.object({ turnId: z.string(), clientRequestId: z.string() }).parse(accepted.payload);
  check(pendingRoomMessages([sendingQuestion], { turns: [acceptedMessage], discussions: beforeQuestion.discussions }, 'qa').length === 0, '实时消息先到时按原请求编号接替本地提问');
  const duplicate = await command(a, 'ask', { text: '故事里有人去世吗？' }, requestId); check(duplicate.turnId === question.turnId, '相同请求编号不会重复提问');
  await command(b, 'host_answer', { turnId: question.turnId!, verdict: 'yes' }); check(room.turns.find((turn) => turn.turnId === question.turnId)?.result === 'yes', '真实用户主持人完成判定');
  const judged = await roomPeer.next((frame) => frame.type === 'turn.completed' && z.object({ turnId: z.string() }).parse(frame.payload).turnId === question.turnId);
  check(judged.type === 'turn.completed' && z.object({ result: z.string() }).parse(judged.payload).result === 'yes', '真实房间连接收到主持人判定事件');
  check(judged.type === 'turn.completed' && !Object.hasOwn(z.object({}).passthrough().parse(judged.payload), 'answer'), '实时判定事件不携带私有汤底');
  if ('seq' in judged) resumeSeq = judged.seq;
} finally { roomPeer.close(); }
const beforeDiscussion = room; const discussionId = randomUUID();
const discussion = await command(a, 'discussion', { text: '我们先整理线索。' }, discussionId); check(room.discussions.length === 1, '房间讨论保存成功');
const sentDiscussion: PendingCommand = { input: { type: 'discussion', clientRequestId: discussionId, payload: { text: '我们先整理线索。' } }, status: 'sent', retries: 0, result: z.object({ clientRequestId: z.string(), status: z.enum(['accepted', 'duplicate']), controlVersion: z.number(), discussionId: z.string() }).parse(discussion) };
check(pendingRoomMessages([sentDiscussion], beforeDiscussion, 'discuss').length === 1, '真实接口确认后等待推送期间仍显示本地讨论');
check(pendingRoomMessages([sentDiscussion], beforeDiscussion, 'qa').length === 0, '本地讨论不混入问答页');
check(pendingRoomMessages([sentDiscussion], room, 'discuss').length === 0, '真实讨论快照接替本地显示');
const reconnectTicket = await call('/realtime/tickets', z.object({ ticket: z.string() }), { actor: a, method: 'POST' });
const reconnected = await RealtimePeer.connect(origin!, reconnectTicket.ticket);
try {
  reconnected.send({ type: 'subscribe', roomId: room.roomId, lastSeq: resumeSeq });
  const missed = await reconnected.next((frame) => frame.type === 'discussion.created');
  check(missed.type === 'discussion.created' && missed.seq > resumeSeq && z.object({ text: z.string() }).parse(missed.payload).text === '我们先整理线索。', '真实重连补齐断开期间的房间讨论');
  await reconnected.next((frame) => frame.type === 'sync.ready');
} finally { reconnected.close(); }
await command(a, 'reveal_hint'); check(room.round!.hints.length === 1, '提示按序公开');
await command(a, 'set_visibility', { isPublic: true }); check(room.isPublic, '公开开关通过房间命令生效');

const found = await call(`/friends/search?email=${encodeURIComponent(b.email)}`, friendSearchResponseSchema, { actor: a }); check(found.userId === b.id, '按邮箱精确找到真实账号');
await call('/friends/requests', anyData, { actor: a, body: { email: b.email } });
const requests = await call('/friends/requests', friendRequestListResponseSchema, { actor: b });
await call(`/friends/requests/${requests.requests[0]!.requestId}/review`, anyData, { actor: b, body: { accept: true } });
const friends = await call('/friends', friendListResponseSchema, { actor: a }); const conversationId = friends.friends[0]!.conversationId!; check(Boolean(conversationId), '双方同意后建立私聊会话');
await call(`/conversations/${conversationId}/messages`, anyData, { actor: a, body: { text: '一起来喝汤。' } });
const messages = await call(`/conversations/${conversationId}/messages`, dmMessageListResponseSchema, { actor: b }); check(messages.messages[0]?.text === '一起来喝汤。', '私聊消息真实送达');
await call(`/conversations/${conversationId}/read`, anyData, { actor: b, body: { lastReadSeq: messages.messages.at(-1)!.seq } });
const notifications = await call('/notifications', notificationListResponseSchema, { actor: b }); check(notifications.notifications.length > 0, '好友与私聊通知可读取');
await call('/notifications/read', anyData, { actor: b, body: { all: true } });

const source = JSON.parse(await readFile(new URL('../../../data/library.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
check(source.length > 0, '试题内容取自项目题库');
// 私有创作只验证保存与权限，完整正文沿用第一道真实题目，避免捏造判题材料。
const realPuzzle = await call(`/puzzles/${puzzleId}?language=zh`, z.object({ title: z.string(), surface: z.string() }));
const created = await call('/creations', z.object({ puzzleId: z.string() }), { actor: a, body: { title: realPuzzle.title, surface: realPuzzle.surface, answer: hostView.answer, hints: hostView.hints, language: 'zh', difficulty: 'medium', category: 'honkaku', origin: 'original', sourceUrl: '', authorDisplay: { mode: 'anonymous' } } });
const detail = await call(`/creations/${created.puzzleId}`, creationDetailSchema, { actor: a }); check(detail.status === 'draft', '创作草稿保存完整');
// 使用原生端的实际保存函数，通过真实 HTTP 验证连续保存不会新建第二份作品。
const nativeSend = sendAs(a);
const nativeFirst = await persistCreation(nativeSend, detail.draft);
const localEdit = localCreationSchema.parse(JSON.parse(JSON.stringify({ draft: nativeFirst.draft, base: nativeFirst })));
check(localEdit.base?.versionId === nativeFirst.versionId && localEdit.base.updatedAt === nativeFirst.updatedAt, '本地编辑结构保留实际作品编号与编辑版本条件');
const nativeSecond = await persistCreation(nativeSend, { ...nativeFirst.draft, title: `${nativeFirst.draft.title}（修订）`.slice(0, 60) }, nativeFirst);
check(nativeFirst.puzzleId === nativeSecond.puzzleId && nativeSecond.draft.title.endsWith('（修订）'), '原生端连续保存更新同一作品');
const works = await call('/creations', z.object({ items: z.array(z.object({ puzzleId: z.string() })) }), { actor: a });
check(works.items.length === 2, '两轮原生保存只创建一份作品');
await assert.rejects(persistCreation(nativeSend, localEdit.draft, localEdit.base), /STATE_CONFLICT/); check(true, '本地编辑结构重读后仍按旧版本提交，服务器拒绝覆盖并发更新');
const nativePreview = await call(`/creations/${nativeSecond.puzzleId}/test-session`, creationPreviewSchema, { actor: a, method: 'POST' });
check(nativePreview.versionId === nativeSecond.versionId && nativePreview.title === nativeSecond.draft.title, '新作品自动保存后可直接创建匹配内容的私人试题');
const judgedPreview = await call('/solo/judge', soloJudgeResponseSchema, { body: { token: nativePreview.token, question: '故事中有人类角色吗？', recentQas: [] } });
check(soloJudgeResponseSchema.safeParse(judgedPreview).success, '私人试题凭证经过真实 AI 判题链路');
const nativeThird = await persistCreation(nativeSend, { ...nativeSecond.draft, title: `${nativeSecond.draft.title}（更新）`.slice(0, 60) }, nativeSecond);
const stalePreview = await raw('/solo/hints', { body: { token: nativePreview.token, index: 0 } });
check(stalePreview.status === 409 && errorBodySchema.parse(stalePreview.body).error.code === 'STATE_CONFLICT', '草稿修改后服务端拒绝旧私人试题凭证');
const freshPreview = await call(`/creations/${nativeThird.puzzleId}/test-session`, creationPreviewSchema, { actor: a, method: 'POST' });
check(freshPreview.contentHash !== nativePreview.contentHash && freshPreview.title === nativeThird.draft.title, '重进试题取得新内容摘要与保存后的标题');
const submittedWork = await transitionCreation(nativeSend, nativeThird, 'submit');
check(submittedWork.status === 'submitted' && submittedWork.versionId === nativeThird.versionId && submittedWork.reviews.some((review) => review.stage === 'submit'), '原生提交函数读取真实待审状态及提交记录');
await assert.rejects(persistCreation(nativeSend, submittedWork.draft, submittedWork), /STATE_CONFLICT/); check(true, '待审版本不可直接覆盖正文');
await assert.rejects(transitionCreation(nativeSend, submittedWork, 'revise'), /STATE_CONFLICT/); check(true, '待审版本必须先撤回，不能直接创建修订');
const signedWork = await updateCreationAuthor(nativeSend, submittedWork.puzzleId, { mode: 'signature', name: '原生测试作者' });
check(signedWork.authorDisplay.pendingName === '原生测试作者' && signedWork.authorDisplay.name === null && signedWork.draft.surface === submittedWork.draft.surface, '待审作品改署名进入名字审核且正文保持原值');
// 创作控制器每分钟最多 20 次请求；后半段检查进入下个真实窗口，保留实际限制。
console.log('创作检查等待下一个真实分钟窗口。');
await new Promise((resolve) => setTimeout(resolve, 60_000 - Date.now() % 60_000 + 100));
const anonymousWork = await updateCreationAuthor(nativeSend, signedWork.puzzleId, { mode: 'anonymous' });
check(anonymousWork.authorDisplay.mode === 'anonymous' && anonymousWork.authorDisplay.pendingName === null, '改为匿名立即生效并撤销待审核署名');
const withdrawnWork = await transitionCreation(nativeSend, anonymousWork, 'withdraw');
check(withdrawnWork.puzzleId === nativeThird.puzzleId && withdrawnWork.status === 'draft' && withdrawnWork.versionNo === submittedWork.versionNo + 1 && withdrawnWork.versionId !== submittedWork.versionId, '原生撤回函数保留作品编号并创建下一版草稿');
check(withdrawnWork.reviews.some((review) => review.conclusion === 'withdrawn') && withdrawnWork.versions.some((version) => version.versionId === submittedWork.versionId && version.status === 'changes_requested'), '撤回后保留原提交版本与审核记录');
check(withdrawnWork.draft.surface === submittedWork.draft.surface && withdrawnWork.draft.answer === submittedWork.draft.answer, '撤回草稿完整保留汤面和汤底');
await assert.rejects(transitionCreation(nativeSend, anonymousWork, 'withdraw'), /STATE_CONFLICT/); check(true, '旧撤回请求不能作用于新草稿');
check(!creationCompleteSchema.safeParse({ ...detail.draft, hints: ['', hostView.hints[0]!] }).success, '第二条提示不能代替必填的第一条提示');
const denied = await raw(`/creations/${created.puzzleId}`, { actor: b }); check(denied.status === 404 || denied.status === 403, '其他账号不能读取私有创作');
await call(`/creations/${created.puzzleId}`, anyData, { actor: a, method: 'PATCH', body: { ...detail.draft, expectedVersionId: detail.versionId, expectedUpdatedAt: detail.updatedAt } });
const preview = await call(`/creations/${created.puzzleId}/test-session`, creationPreviewSchema, { actor: a, method: 'POST' }); check(Boolean(preview.token), '创作试题使用真实服务端凭证');
await call(`/ratings/${puzzleId}`, myRatingSchema, { actor: a, method: 'PUT', body: { value: 'up' } });
await call(`/ratings/${puzzleId}`, myRatingSchema, { actor: a, method: 'DELETE' });
await command(a, 'reveal_answer'); check(room.roomStatus === 'closed', '揭晓后归档房间');
check(canRateRoomPuzzle(room.round!.status), '公布答案后的多人局展示评价');
const afterClose = await call('/me/active-rooms', z.object({ rooms: z.array(z.object({ roomId: z.string() })) }), { actor: a }); check(!afterClose.rooms.some((item) => item.roomId === started.roomId), '已结束的房间从首页进行中列表移除');
await call('/me/history?page=1&limit=5', z.object({ rooms: z.array(z.unknown()), hasMore: z.boolean() }), { actor: a });
await call('/auth/sign-out', anyData, { actor: b, method: 'POST' }); const revoked = await raw('/me', { actor: b }); check(revoked.status === 401, '退出登录撤销 Bearer 会话');
console.log(`全部 ${checks} 项真实接口检查通过；未替代 TapTap 真机验收。`);
