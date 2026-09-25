/**
 * 房间域：多人房间、成员、局、问答任务、房间事件。
 *
 * 四条数据库层不变量（部分唯一索引，业务层不得绕过）：
 *  1. 同一局最多一个 processing 任务
 *  2. 同一局同一用户最多一个 queued/processing 任务
 *  3. 同一房间最多一个进行中局
 *  4. 同一创建者最多一个未关闭房间
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
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { puzzleVersions } from './content';

// ---------- 枚举 ----------

export const roomStatusEnum = pgEnum('room_status', ['waiting', 'playing', 'closed']);

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
    /** 开房授权（免费预留 / 赞助），建房事务里写入 */
    entitlementId: uuid('entitlement_id'),
    /** 等待室中房主已选定的题目版本；start_round 用它开新局 */
    selectedPuzzleVersionId: uuid('selected_puzzle_version_id'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    closeReason: closeReasonEnum('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // 不变量 4：一个创建者最多一个未关闭房间
    uniqueIndex('rooms_one_open_per_creator_uq')
      .on(t.creatorUserId)
      .where(sql`status <> 'closed'`),
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

/** 每人最多一个进行中房间：user_id 主键即唯一约束；退出/关闭时删除行。 */
export const activeRoomUsers = pgTable('active_room_users', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** 在线状态：按用户聚合连接；心跳更新 last_seen_at，跨进程读取（房主转让、全员离线判定）。 */
export const presence = pgTable(
  'presence',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('presence_room_idx').on(t.roomId)],
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
      .references(() => puzzleVersions.id),
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
    // 不变量 3：一个房间最多一个进行中局
    uniqueIndex('rounds_one_active_per_room_uq')
      .on(t.roomId)
      .where(sql`status = 'active'`),
    uniqueIndex('rounds_room_no_uq').on(t.roomId, t.roundNo),
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
    reviewVersionId: uuid('review_version_id').references(() => puzzleVersions.id),
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
