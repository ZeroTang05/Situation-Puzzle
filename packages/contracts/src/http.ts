/**
 * HTTP 契约：请求/响应结构与房间命令（docs/rebuild/03-SPEC.md §6）。
 * 服务端先 Zod 校验再执行；客户端按这些 Schema 生成请求。
 */
import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

export const languageSchema = z.enum(['zh', 'en']);
export type Language = z.infer<typeof languageSchema>;

// ---------- 通用信封 ----------

export const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    /** 展示用参数（如剩余秒数），客户端按 code+params 翻译 */
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  requestId: z.string(),
});

export function dataEnvelope<T>(data: T, requestId: string) {
  return { data, requestId };
}

// ---------- 题库 ----------

export const puzzleListItemSchema = z.object({
  id: z.string(),
  legacyId: z.string().nullable(),
  title: z.string(),
  surface: z.string(),
  difficulty: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  contentWarnings: z.array(z.string()),
  language: languageSchema,
  versionId: z.string(),
  /** 本地已玩信息由客户端合并，服务端不下发 */
});

export const puzzleDetailSchema = puzzleListItemSchema.extend({
  coreFacts: z.array(z.string()).optional(),
  /** 汤底与提示永远不出现在公开详情里 */
});

// ---------- 单人 ----------

export const soloSessionRequestSchema = z.object({
  puzzleId: z.string().uuid(),
  language: languageSchema,
  versionId: z.string().uuid().optional(),
});

export const soloSessionResponseSchema = z.object({
  token: z.string(),
  puzzleId: z.string(),
  versionId: z.string(),
  language: languageSchema,
  title: z.string(),
  surface: z.string(),
  hintsTotal: z.number().int(),
  /** 凭证绑定的判题配置版本：本地记录用于展示一致性 */
  configVersion: z.string(),
});

export const soloJudgeRequestSchema = z.object({
  token: z.string(),
  question: z.string().min(1).max(500),
});

export const soloJudgeResponseSchema = z.object({
  result: z.enum(['yes', 'no', 'irrelevant', 'uncertain']),
});

export const soloSolveRequestSchema = z.object({
  token: z.string(),
  solution: z.string().min(1).max(1500),
});

export const soloSolveResponseSchema = z.object({
  result: z.enum(['solved', 'close', 'not_yet', 'uncertain']),
  /** 破解成功时一并下发汤底 */
  answer: z.string().optional(),
});

export const soloHintRequestSchema = z.object({
  token: z.string(),
  index: z.number().int().min(0).max(2),
});

export const soloRevealRequestSchema = z.object({
  token: z.string(),
  confirmed: z.literal(true),
});

// ---------- 房间 ----------

export const roomCreateRequestSchema = z.object({
  capacity: z.number().int().min(2).max(8).default(8),
});

export const roomSummarySchema = z.object({
  roomId: z.string(),
  status: z.enum(['waiting', 'playing', 'closed']),
  capacity: z.number().int(),
  memberCount: z.number().int(),
  hostUserId: z.string(),
  inviteToken: z.string().optional(),
});

export const invitePreviewSchema = z.object({
  roomId: z.string(),
  status: z.enum(['waiting', 'playing', 'closed']),
  capacity: z.number().int(),
  memberCount: z.number().int(),
  hostNickname: z.string(),
  currentPuzzleTitle: z.string().nullable(),
});

export const roomJoinRequestSchema = z.object({
  token: z.string().min(8),
});

// ---------- 题目投票与作者署名（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md） ----------

export const voteValueSchema = z.enum(['up', 'down']);
export type VoteValue = z.infer<typeof voteValueSchema>;

/** 公开署名投影：匿名时 name 为 null，不含内部作者归属 */
export const authorDisplaySchema = z.object({
  mode: z.enum(['anonymous', 'signature']),
  name: z.string().nullable(),
});

export const ratingStatsSchema = z.object({
  upCount: z.number().int(),
  downCount: z.number().int(),
});

/** 本人选择与最新统计：只向本人返回 choice，响应禁止公共缓存 */
export const myRatingSchema = ratingStatsSchema.extend({
  choice: voteValueSchema.nullable(),
});

/** PUT /ratings/:puzzleId：明确设置选择（客户端切换=PUT 或 DELETE，不做「切换」服务器命令） */
export const ratingPutRequestSchema = z.object({
  value: voteValueSchema,
});

/** 创作署名设置：signature 时 name 必填（1～30 字符，服务端去首尾空格） */
export const authorDisplaySettingSchema = z.object({
  mode: z.enum(['anonymous', 'signature']),
  name: z.string().max(30).optional(),
});

/** 再来一题：从已归档房间创建独立新房并一键迁移合格成员（10-ROOM-LIFECYCLE-REVISION §一.2/3） */
export const roomFollowupRequestSchema = z.object({
  sourceRoomId: z.string().uuid(),
  puzzleId: z.string().uuid(),
  language: languageSchema,
});

export const roomFollowupMemberSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  /** false 时 reason 说明未迁入原因（in_other_room / room_full） */
  migrated: z.boolean(),
  reason: z.enum(['in_other_room', 'room_full']).optional(),
});

export const roomFollowupResponseSchema = z.object({
  sourceRoomId: z.string(),
  targetRoomId: z.string(),
  /** 重复请求返回同一目标房 */
  existing: z.boolean(),
  /** 新房邀请令牌（仅首次创建返回；成员已直接迁入，此链接用于邀请新朋友） */
  inviteToken: z.string().optional(),
  members: z.array(roomFollowupMemberSchema),
});

// ---------- 房间命令 ----------

export const commandTypes = [
  'select_puzzle',
  'start_round',
  'ask',
  'solve',
  'cancel_turn',
  'discussion',
  'reveal_hint',
  'reveal_answer',
  'end_round',
  'leave',
  'kick',
  'unrestrict_member',
  'transfer_host',
  'rotate_invite',
  'close_room',
] as const;

export const commandTypeSchema = z.enum(commandTypes);
export type CommandType = (typeof commandTypes)[number];

/** 命令 payload 按类型分派 */
export const commandPayloadSchemas = {
  select_puzzle: z.object({ puzzleId: z.string().uuid(), language: languageSchema }),
  start_round: z.object({}),
  ask: z.object({ text: z.string().min(1).max(500) }),
  solve: z.object({ text: z.string().min(1).max(1500) }),
  cancel_turn: z.object({ turnId: z.string().uuid() }),
  discussion: z.object({ text: z.string().min(1).max(1000) }),
  reveal_hint: z.object({}),
  reveal_answer: z.object({}),
  end_round: z.object({}),
  leave: z.object({}),
  kick: z.object({ userId: z.string() }),
  unrestrict_member: z.object({ userId: z.string() }),
  transfer_host: z.object({ userId: z.string() }),
  rotate_invite: z.object({}),
  close_room: z.object({}),
} as const satisfies Record<CommandType, z.ZodTypeAny>;

export const roomCommandRequestSchema = z.object({
  clientRequestId: z.string().uuid(),
  type: commandTypeSchema,
  roundId: z.string().uuid().optional(),
  /** 控制命令必须携带期望的控制版本；讨论与判题提交不携带 */
  expectedControlVersion: z.number().int().optional(),
  payload: z.unknown(),
});

export const roomCommandResponseSchema = z.object({
  clientRequestId: z.string().uuid(),
  discussionId: z.string().uuid().optional(),
  inviteToken: z.string().optional(),
  status: z.enum(['accepted', 'duplicate']),
  /** ask/solve 返回问答编号与受理事件序号 */
  turnId: z.string().uuid().optional(),
  acceptedSeq: z.number().optional(),
  controlVersion: z.number().int(),
});

export const roomCommandLookupSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), result: roomCommandResponseSchema }),
  z.object({ status: z.literal('not_found') }),
]);

// ---------- 快照与事件补齐 ----------

export const snapshotMemberSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  online: z.boolean(),
  isHost: z.boolean(),
  /** joined | left | kicked：kicked 成员不出现在快照里，此字段预留给成员页 */
  status: z.enum(['joined', 'left']),
});

export const snapshotTurnSchema = z.object({
  turnId: z.string(),
  seq: z.number(),
  userId: z.string(),
  nickname: z.string(),
  kind: z.enum(['ask', 'solve']),
  text: z.string(),
  status: z.enum(['queued', 'processing', 'succeeded', 'failed', 'cancelled']),
  result: z.string().nullable(),
});

export const roomSnapshotSchema = z.object({
  roomId: z.string(),
  roomStatus: z.enum(['waiting', 'playing', 'closed']),
  hostUserId: z.string(),
  controlVersion: z.number().int(),
  capacity: z.number().int(),
  /** 当前局（无则为 null：等待室状态） */
  round: z
    .object({
      roundId: z.string(),
      roundNo: z.number().int(),
      puzzleId: z.string(),
      versionId: z.string(),
      language: languageSchema,
      title: z.string(),
      surface: z.string(),
      hintsRevealed: z.number().int(),
      hints: z.array(z.string()),
      status: z.enum(['active', 'solved', 'revealed', 'abandoned', 'aborted']),
      /** 已揭晓时包含汤底 */
      answer: z.string().nullable(),
    })
    .nullable(),
  members: z.array(snapshotMemberSchema),
  turns: z.array(snapshotTurnSchema),
  discussions: z.array(z.object({ eventId: z.string(), seq: z.number(), clientRequestId: z.string().optional(), userId: z.string(), nickname: z.string(), text: z.string(), at: z.number() })),
  followupTargetRoomId: z.string().nullable(),
  /** 快照对应的最后事件序号 */
  lastSeq: z.number(),
});

// ---------- 实时 ----------

export const realtimeTicketResponseSchema = z.object({
  ticket: z.string(),
  expiresInSeconds: z.number().int(),
});

// ---------- 账号与赞助 ----------

export const meResponseSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  roles: z.array(z.string()),
  sponsorship: z.object({
    monthlyUntil: z.string().nullable(),
    lifetime: z.boolean(),
  }),
  freeRooms: z.object({
    total: z.number().int(),
    consumed: z.number().int(),
    reserved: z.number().int(),
  }),
});

/** 修改昵称：允许与其他玩家重名，仅约束 1～30 字符（服务端去首尾空格） */
export const nicknameUpdateRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(30),
});

export const sponsorProductSchema = z.object({
  productVersionId: z.string(),
  type: z.enum(['monthly', 'lifetime']),
  title: z.string(),
  priceMinor: z.number().int(),
  currency: z.string(),
});

export const orderCreateRequestSchema = z.object({
  productVersionId: z.string().uuid(),
});

export const orderSchema = z.object({
  orderId: z.string(),
  status: z.enum(['pending', 'paid', 'closing', 'closed', 'refund_pending', 'refunded']),
  amountMinor: z.number().int(),
  currency: z.string(),
  title: z.string(),
  /** 通道支付跳转信息（native 为二维码内容），通道未开通时为 null */
  payUrl: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

// ---------- 历史 ----------

export const roundHistoryResponseSchema = z.object({
  items: z.array(
    z.object({
      turnId: z.string(),
      seq: z.number(),
      userId: z.string(),
      nickname: z.string(),
      kind: z.enum(['ask', 'solve']),
      text: z.string(),
      status: z.enum(['queued', 'processing', 'succeeded', 'failed', 'cancelled']),
      result: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const roundAnswerResponseSchema = z.object({
  answer: z.string(),
  hints: z.array(z.string()),
});
