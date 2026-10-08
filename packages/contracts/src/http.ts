/**
 * HTTP 契约：请求/响应结构与房间命令（docs/rebuild/03-SPEC.md §6）。
 * 服务端先 Zod 校验再执行；客户端按这些 Schema 生成请求。
 */
import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

export const languageSchema = z.enum(['zh', 'en']);
export type Language = z.infer<typeof languageSchema>;

export const difficultySchema = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof difficultySchema>;

/** 题目类别：honkaku=本格（汤底须现实合理），henkaku=变格（允许超自然设定）；存量内容为 null。 */
export const puzzleCategorySchema = z.enum(['honkaku', 'henkaku']);
export type PuzzleCategory = z.infer<typeof puzzleCategorySchema>;

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

/** 随机换题只从当前语言的已发布作品中选择，可排除正在玩的作品。 */
export const randomPuzzleQuerySchema = z.object({
  language: languageSchema.default('zh'),
  exclude: z.string().uuid().optional(),
});

export const randomPuzzleResponseSchema = z.object({
  puzzleId: z.string().uuid(),
});

export const puzzleListItemSchema = z.object({
  id: z.string(),
  legacyId: z.string().nullable(),
  title: z.string(),
  surface: z.string(),
  difficulty: difficultySchema.nullable(),
  category: puzzleCategorySchema.nullable(),
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
  difficulty: difficultySchema.nullable(),
  category: puzzleCategorySchema.nullable(),
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
  confidence: z.number().min(0).max(1),
});

export const soloSolveRequestSchema = z.object({
  token: z.string(),
  solution: z.string().min(1).max(1500),
});

export const soloSolveResponseSchema = z.object({
  result: z.enum(['solved', 'close', 'not_yet', 'uncertain']),
  confidence: z.number().min(0).max(1),
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

// ---------- 等待室（内存临时态，开局前不入库；docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md §三） ----------

/** 等待室里房主已选定的题目投影：标题与语言公开，不含汤底 */
export const roomSelectedPuzzleSchema = z.object({ puzzleId: z.string(), title: z.string(), language: languageSchema });

export const lobbyCreateRequestSchema = z.object({
  capacity: z.number().int().min(2).max(8).default(8),
});

export const lobbyCreateResponseSchema = z.object({
  lobbyId: z.string().uuid(),
  /** 已存在会客厅（host_user_id UNIQUE 命中） */
  existed: z.boolean(),
});

/** 房主重置会客厅邀请的响应：明文 token 只返回这一次 */
export const lobbyInviteResponseSchema = z.object({
  token: z.string(),
});

export const lobbyPreviewSchema = z.object({
  lobbyId: z.string().uuid(),
  hostNickname: z.string(),
  memberCount: z.number().int(),
  capacity: z.number().int(),
});

export const lobbyJoinRequestSchema = z.object({
  token: z.string().min(8),
});

export const lobbyJoinResponseSchema = z.object({
  lobbyId: z.string().uuid(),
});

export const lobbyMemberSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  online: z.boolean(),
  isHost: z.boolean(),
});

export const lobbySnapshotSchema = z.object({
  lobbyId: z.string().uuid(),
  hostUserId: z.string(),
  capacity: z.number().int(),
  members: z.array(lobbyMemberSchema),
  selectedPuzzle: roomSelectedPuzzleSchema.nullable(),
});

export const lobbySelectRequestSchema = z.object({
  puzzleId: z.string().uuid(),
  language: languageSchema,
});

/** 开局响应：正式房间 ID + 邀请令牌（开局后邀请更多玩家用） */
export const lobbyStartResponseSchema = z.object({
  roomId: z.string().uuid(),
  inviteToken: z.string(),
});

// ---------- 房间 ----------

export const invitePreviewSchema = z.object({
  roomId: z.string(),
  status: z.enum(['playing', 'closed']),
  capacity: z.number().int(),
  memberCount: z.number().int(),
  hostNickname: z.string(),
  currentPuzzleTitle: z.string().nullable(),
});

export const roomJoinRequestSchema = z.object({
  token: z.string().min(8),
});

/** 老成员重入：曾加入且未被踢的成员直接凭房间链接回到 playing 房间。 */
export const roomRejoinResponseSchema = z.object({
  roomId: z.string(),
  rejoined: z.boolean(),
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
  /** false 时 reason 说明未迁入原因（room_full） */
  migrated: z.boolean(),
  reason: z.enum(['room_full']).optional(),
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

/** 选题与开局发生在等待室（HTTP 接口），不作为房间命令；转让房主功能不存在。 */
export const commandTypes = [
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
  'rotate_invite',
  'close_room',
] as const;

export const commandTypeSchema = z.enum(commandTypes);
export type CommandType = (typeof commandTypes)[number];

/** 命令 payload 按类型分派，由请求契约统一校验。 */
export const commandPayloadSchemas = {
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
  rotate_invite: z.object({}),
  close_room: z.object({}),
} as const satisfies Record<CommandType, z.ZodTypeAny>;

export const roomCommandRequestSchema = z.object({
  clientRequestId: z.string().uuid(),
  type: commandTypeSchema,
  roundId: z.string().uuid().optional(),
  /** 控制命令必须携带期望的控制版本；讨论与判题提交不携带 */
  expectedControlVersion: z.number().int().optional(),
  /** 无参数命令允许省略；有参数命令仍须通过对应类型的字段校验。 */
  payload: z.record(z.string(), z.unknown()).default({}),
}).superRefine((request, context) => {
  const parsed = commandPayloadSchemas[request.type].safeParse(request.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.message });
    }
  }
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

/** 房间历史每页有明确上限，避免个人页一次展示所有记录。 */
export const roomHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

/** 房间自创建即 playing（v2：等待室不入库），快照不再携带选题预览 */
export const roomSnapshotSchema = z.object({
  roomId: z.string(),
  roomStatus: z.enum(['playing', 'closed']),
  hostUserId: z.string(),
  controlVersion: z.number().int(),
  capacity: z.number().int(),
  /** 当前局（无则为 null） */
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
