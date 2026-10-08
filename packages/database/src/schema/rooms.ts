/**
 * 房间域：多人房间、成员、局、问答任务、房间事件、续玩关系。
 *
 * 数据库层不变量（唯一索引，业务层不得绕过）：
 *  1. 同一局最多一个 processing 任务
 *  2. 同一局同一用户最多一个 queued/processing 任务
 *  3. 一个房间至多一局（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md：一房一题）
 *  4. 一个源房间至多一条续玩记录（重复请求返回同一目标房）
 */
import { sql } from 'drizzle-orm';
import {
  pgEnum,
  pgTable,
  text,
  uuid,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { puzzleVersions } from './content';

// ---------- 枚举 ----------

export const roomStatusEnum = pgEnum('room_status', ['waiting', 'playing', 'closed']);

/**
 * 会客厅状态：open = 当前有客人坐着或选了题；closed = 临时态已清空
 * （start 后回到 closed；房主从未邀请过人也是 closed）。
 * host_user_id UNIQUE 保证「每个用户固定一个会客厅 id」，
 * 临时态是 open/closed 二选一，会客厅行不 delete。
 */
export const lobbyStatusEnum = pgEnum('lobby_status', ['closed', 'open']);

export const memberStatusEnum = pgEnum('member_status', ['joined', 'left', 'kicked']);

export const roundStatusEnum = pgEnum('round_status', ['active', 'solved', 'revealed', 'abandoned', 'aborted']);

export const turnKindEnum = pgEnum('turn_kind', ['ask', 'solve']);

export const turnStatusEnum = pgEnum('turn_status', ['queued', 'processing', 'succeeded', 'failed', 'cancelled']);

export const closeReasonEnum = pgEnum('close_reason', [
  'by_host',
  'idle',
  'all_offline',
  'moderation',
  'host_left',
  /** 破解或公布汤底后归档（10-ROOM-LIFECYCLE-REVISION §一.1） */
  'round_ended',
  /** v2 迁移：存量 waiting 房（建了未开局）归档，等效从未存在 */
  'never_started',
]);

// ---------- 房间 ----------

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 创建者：开房计费对象；房主可转让，创建者不变 */
    creatorUserId: text('creator_user_id')
      .notNull()
      .references(() => user.id),
    hostUserId: text('host_user_id')
      .notNull()
      .references(() => user.id),
    status: roomStatusEnum('status').notNull().default('waiting'),
    capacity: integer('capacity').notNull().default(8),
    /** 邀请令牌只存散列；明文只在创建/重置时返回一次 */
    inviteTokenHash: text('invite_token_hash').notNull(),
    /** 控制版本号：select/start/end 等控制命令乐观并发 */
    controlVersion: integer('control_version').notNull().default(0),
    /** 房间事件高水位：事件表的最大 seq，快照握手用 */
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    /** 开房授权（免费预留 / 赞助），开局事务里写入（v2：等待室不入库） */
    entitlementId: uuid('entitlement_id'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    closeReason: closeReasonEnum('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rooms_invite_token_uq').on(t.inviteTokenHash),
    index('rooms_status_idx').on(t.status),
  ],
);

export const roomMembers = pgTable(
  'room_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    status: memberStatusEnum('status').notNull().default('joined'),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true, mode: 'date' }),
    /** 被移除时间：房主解除限制后才能重入 */
    kickedAt: timestamp('kicked_at', { withTimezone: true, mode: 'date' }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_members_room_user_uq').on(t.roomId, t.userId),
    index('room_members_user_idx').on(t.userId),
  ],
);

// ---------- 会客厅（lobby）----------

/**
 * 会客厅：每个用户固定一个，id 永久不变。
 * 不变量：host_user_id UNIQUE —— 物理上保证 1:1，无需 partial index。
 *
 * 临时态字段（selected_puzzle_*）可空、可被 start 事务清空。
 * status='open' = 当前有客人坐着或选了题；'closed' = 空或刚开完游戏。
 * start() 后清临时态、删 lobby_members、revoke 邀请，lobby 行保留。
 *
 * 用户注销账号时 CASCADE 清掉（host_user_id FK + members/invites CASCADE）。
 */
export const userLobbies = pgTable(
  'user_lobbies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostUserId: text('host_user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: lobbyStatusEnum('status').notNull().default('closed'),
    capacity: integer('capacity').notNull().default(8),
    selectedPuzzleId: text('selected_puzzle_id'),
    selectedPuzzleLang: text('selected_puzzle_lang'),
    selectedPuzzleTitle: text('selected_puzzle_title'),
    selectedPuzzleSurface: text('selected_puzzle_surface'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('user_lobbies_status_idx').on(t.status)],
);

/**
 * 会客厅当前座位表：kick = DELETE 本行（不留 kicked_at，按用户要求
 * 「这次游戏被踢，不是永久被踢」）。
 * 心跳不进 DB：lastSeenAt 走进程内 Map 派生在线状态。
 */
export const lobbyMembers = pgTable(
  'lobby_members',
  {
    lobbyId: uuid('lobby_id')
      .notNull()
      .references(() => userLobbies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.lobbyId, t.userId] }),
    index('lobby_members_user_idx').on(t.userId),
  ],
);

/**
 * 会客厅邀请 token：跟 user_lobbies 同生命周期。
 * 房主重置邀请时把旧行 revoked_at 置位 + 发新行；同 lobby 同一时刻最多 1 条有效。
 * 不存明文，只存 hash；明文在创建/重置时返回一次。
 */
export const lobbyInvites = pgTable(
  'lobby_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lobbyId: uuid('lobby_id')
      .notNull()
      .references(() => userLobbies.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('lobby_invites_lobby_idx').on(t.lobbyId),
    index('lobby_invites_active_idx').on(t.lobbyId).where(sql`revoked_at IS NULL`),
  ],
);

/** 在线状态按房间和用户记录；同一用户可同时订阅多个房间。 */
export const presence = pgTable(
  'presence',
  {
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index('presence_room_idx').on(t.roomId)],
);

// ---------- 局 ----------

export const rounds = pgTable(
  'rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    roundNo: integer('round_no').notNull(),
    /** 开局固定的题目版本：旧局不受题目更新影响 */
    puzzleVersionId: uuid('puzzle_version_id')
      .notNull()
      .references(() => puzzleVersions.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    status: roundStatusEnum('status').notNull().default('active'),
    hintsRevealed: integer('hints_revealed').notNull().default(0),
    effectiveVerdicts: integer('effective_verdicts').notNull().default(0),
    /** 取消代次：每次终止未完成任务加一，迟到结果必须核对它 */
    cancelGeneration: integer('cancel_generation').notNull().default(0),
    /** 开局固定的判题配置版本（模型/提示词/阈值） */
    jevConfigVersion: text('jev_config_version').notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // 不变量 3：一个房间至多一局（一房一题；多局旧数据已在迁移前统计，见 10 号文档 R11）
    uniqueIndex('rounds_room_id_uq').on(t.roomId),
    index('rounds_status_idx').on(t.status),
  ],
);

// ---------- 局参与者 ----------

/** 局参与者：进过本局的人才有历史阅读权；被移除/封禁撤销。 */
export const roundParticipants = pgTable(
  'round_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => rounds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true, mode: 'date' }),
    /** 揭晓后标记（含自己声明已知答案） */
    knowsAnswer: boolean('knows_answer').notNull().default(false),
    canRead: boolean('can_read').notNull().default(true),
  },
  (t) => [uniqueIndex('round_participants_round_user_uq').on(t.roundId, t.userId)],
);

// ---------- 续玩关系 ----------

/**
 * 续玩关系（再来一题）：源房 → 目标房的迁移记录。
 * source_room_id 唯一保证重复请求返回同一目标房；成员迁移结果存 jsonb 快照。
 */
export const roomFollowups = pgTable(
  'room_followups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceRoomId: uuid('source_room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    targetRoomId: uuid('target_room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** 发起者（原房房主） */
    initiatedBy: text('initiated_by')
      .notNull()
      .references(() => user.id),
    /** 每个成员的迁移结果：[{ userId, nickname, migrated, reason? }] */
    memberResults: jsonb('member_results').$type<Array<Record<string, unknown>>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // 不变量 4：一个源房间至多一条续玩记录
    uniqueIndex('room_followups_source_uq').on(t.sourceRoomId),
    index('room_followups_target_idx').on(t.targetRoomId),
  ],
);

// ---------- 命令与问答 ----------

/** 命令幂等记录：相同用户+编号返回原结果；所属局结束后至少保留 30 天。 */
export const commands = pgTable(
  'commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    clientRequestId: text('client_request_id').notNull(),
    type: text('type').notNull(),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id').references(() => rounds.id, { onDelete: 'cascade' }),
    /** 请求内容摘要：同编号不同内容 → 冲突 */
    payloadDigest: text('payload_digest').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('commands_user_request_uq').on(t.userId, t.clientRequestId)],
);

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => rounds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    kind: turnKindEnum('kind').notNull(),
    text: text('text').notNull(),
    /** 受理顺序：房间事件 seq，同局排队按它递增，不按客户端时间 */
    acceptedSeq: bigint('accepted_seq', { mode: 'number' }).notNull(),
    status: turnStatusEnum('status').notNull().default('queued'),
    /** ask: yes/no/irrelevant/uncertain；solve: solved/close/not_yet/uncertain */
    result: text('result'),
    confidence: text('confidence'),
    failReason: text('fail_reason'),
    /** 任务进程领取时写入，完成时校验一致才可提交结果 */
    executionToken: uuid('execution_token'),
    retryCount: integer('retry_count').notNull().default(0),
    /** 领取占用期限：60 秒内未完成视为失效 */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    /** 总执行期限：45 秒 */
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
    cancelGeneration: integer('cancel_generation').notNull().default(0),
    /** 领取的任务配置版本，与局配置核对 */
    jevConfigVersion: text('jev_config_version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    // 不变量 1：同一局最多一个 processing 任务
    uniqueIndex('turns_one_processing_per_round_uq')
      .on(t.roundId)
      .where(sql`status = 'processing'`),
    // 不变量 2：同一局同一用户最多一个排队/处理中任务
    uniqueIndex('turns_one_active_per_user_uq')
      .on(t.roundId, t.userId)
      .where(sql`status in ('queued', 'processing')`),
    index('turns_round_status_idx').on(t.roundId, t.status),
    index('turns_user_idx').on(t.userId),
  ],
);

// ---------- 事件 ----------

/** 房间事件：权威公开记录；同时承担可靠发送（网关按 seq 扫描补发）。 */
export const roomEvents = pgTable(
  'room_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id').references(() => rounds.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    /** 公开投影：讨论原文、提问原文、判定结果等；不含汤底与私有数据 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_events_room_seq_uq').on(t.roomId, t.seq),
    uniqueIndex('room_events_event_id_uq').on(t.eventId),
    index('room_events_room_created_idx').on(t.roomId, t.createdAt),
  ],
);

// ---------- Jev 调用记录 ----------

/** 多人判题调用明细：审计与成本统计；单人不写这张表。 */
export const jevCalls = pgTable(
  'jev_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    turnId: uuid('turn_id').references(() => turns.id, { onDelete: 'cascade' }),
    reviewVersionId: uuid('review_version_id').references(() => puzzleVersions.id, { onDelete: 'cascade' }),
    /** 每次真实尝试一条记录，重试不合并 */
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull(),
    choice: text('choice'),
    confidence: text('confidence'),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    costSource: text('cost_source'),
    errorClass: text('error_class'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('jev_calls_turn_idx').on(t.turnId), index('jev_calls_started_idx').on(t.startedAt)],
);
