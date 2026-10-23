/**
 * 社交域：好友申请、好友关系、私聊会话与消息、站内信与通知。
 *
 * 关键不变量（数据库唯一索引兜底，业务层不得绕过）：
 *  1. 同一对用户同时最多一条待审好友申请（按 user_low/user_high 规范化，双向都算）
 *  2. 好友关系是双向两行（user_id → friend_user_id），主键保证不重复、不能指向自己
 *  3. 两个用户之间最多一个会话（同样按规范化的一对唯一）
 *  4. 同一会话内消息序号唯一（已读水位按序号，不用时间戳）
 *  5. 通知的未读统计靠 (user_id, read_at IS NULL) 部分索引
 *
 * 隐私口径：邮箱只用于「精确匹配添加好友」，不做前缀模糊搜索，避免枚举站内邮箱。
 */
import { sql } from 'drizzle-orm';
import {
  pgEnum,
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  bigint,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { rooms } from './rooms';

/** 好友申请状态：pending 待对方处理；其余为终态。 */
export const friendRequestStatusEnum = pgEnum('friend_request_status', [
  'pending',
  'accepted',
  'rejected',
  'canceled',
]);

/**
 * 私聊消息类型：text 普通文本；room_invite 是「来一局」生成的开局卡片（带 room_id）。
 * 卡片也是一条消息，因此在聊天记录里天然有序，不会另开一张表。
 */
export const dmMessageKindEnum = pgEnum('dm_message_kind', ['text', 'room_invite']);

/**
 * 通知类型：
 *  - dm               有人给你发来私聊消息
 *  - friend_request   有人申请加你为好友
 *  - friend_accepted  对方接受了你的好友申请
 *  - room_invite      好友在私聊里给你开了一局
 *  - announcement     站内信（管理员群发）
 *  - system           平台系统通知
 */
export const notificationTypeEnum = pgEnum('notification_type', [
  'dm',
  'friend_request',
  'friend_accepted',
  'room_invite',
  'announcement',
  'system',
]);

/**
 * 好友申请：一对用户只留一条「当前有效」的申请。
 * user_low / user_high 是规范化的用户 id 对（字典序），因此 A→B 与 B→A 互相冲突，
 * 不会出现双方同时各发一条 pending 的局面；谁发起的由 requester_user_id 记录。
 */
export const friendRequests = pgTable(
  'friend_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userLow: text('user_low')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userHigh: text('user_high')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 发起人（永远是 user_low / user_high 之一） */
    requesterUserId: text('requester_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: friendRequestStatusEnum('status').notNull().default('pending'),
    /** 附言（≤200 字）；对方接受前能看到 */
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    // 不变量 1：同一对用户同时最多一条待审申请（双向）
    uniqueIndex('friend_requests_pending_pair_uq')
      .on(t.userLow, t.userHigh)
      .where(sql`status = 'pending'`),
    index('friend_requests_requester_idx').on(t.requesterUserId),
    index('friend_requests_low_idx').on(t.userLow),
    index('friend_requests_high_idx').on(t.userHigh),
    check('friend_requests_pair_distinct', sql`user_low <> user_high`),
  ],
);

/**
 * 好友关系：双向各存一行（user_id → friend_user_id）。
 * 查询「我的好友」只查 user_id = 本人那一侧；删好友要删两行。
 */
export const friendships = pgTable(
  'friendships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    friendUserId: text('friend_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // 不变量 2：一对用户的关系不重复，且不能指向自己
    primaryKey({ columns: [t.userId, t.friendUserId] }),
    check('friendships_not_self', sql`user_id <> friend_user_id`),
  ],
);

/**
 * 私聊会话：两个好友之间一个会话。
 * user_low / user_high 规范化，保证「谁先发起的」不会产生两个会话。
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userLow: text('user_low')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userHigh: text('user_high')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // 不变量 3：两个用户之间最多一个会话
    uniqueIndex('conversations_pair_uq').on(t.userLow, t.userHigh),
    check('conversations_pair_distinct', sql`user_low <> user_high`),
  ],
);

/** 私聊消息：只存好友之间的内容；不参与房间事件流。 */
export const dmMessages = pgTable(
  'dm_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderUserId: text('sender_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 会话内递增序号：已读水位与排序都按它，不用时间戳（同毫秒会丢消息） */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: dmMessageKindEnum('kind').notNull().default('text'),
    text: text('text').notNull(),
    /** kind='room_invite' 时指向开局房间；房间归档后卡片仍留，但不再可点进去 */
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('dm_messages_conversation_idx').on(t.conversationId, t.createdAt),
    // 不变量 4：同一会话内序号唯一
    uniqueIndex('dm_messages_conversation_seq_uq').on(t.conversationId, t.seq),
  ],
);

/** 每个用户在每个会话的已读水位：未读数 = 该水位之后的消息数。 */
export const conversationReads = pgTable(
  'conversation_reads',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

/** 站内信：管理员群发的公告。面向全站用户，发布时给每个用户落一条通知。 */
export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** 发布人（管理员） */
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('announcements_published_idx').on(t.publishedAt)],
);

/**
 * 通知：私聊提醒、好友申请、站内信都落这里，统一未读计数。
 * 只存展示所需的投影（标题、正文、跳转地址），不复制被提醒对象的完整内容。
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** 触发者：发消息 / 发申请 / 开局的人 */
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    announcementId: uuid('announcement_id').references(() => announcements.id, { onDelete: 'cascade' }),
    /** 前端跳转路径（站内相对路径） */
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    // 不变量 4：未读统计走部分索引
    index('notifications_unread_idx').on(t.userId).where(sql`read_at IS NULL`),
  ],
);

/**
 * 好友申请的附言长度上限在 @jev/contracts（FRIEND_REQUEST_MESSAGE_MAX），
 * 数据库不重复定义，避免两处口径漂移。
 */
