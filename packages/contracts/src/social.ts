/**
 * 社交域契约：好友申请-同意、私聊消息、快捷开局、通知中心与站内信
 * （docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * 服务端按这些 Schema 校验请求，客户端按同一份 Schema 构造请求与解析响应。
 * 长度上限在这里定死（前端提示、服务端校验、领域规则共用同一口径）。
 */
import { z } from 'zod';
import { languageSchema } from './http.js';

/** 好友申请的附言长度上限（≤200 字）。 */
export const FRIEND_REQUEST_MESSAGE_MAX = 200;
/** 单条私聊正文长度上限。 */
export const DM_TEXT_MAX = 1000;
/** 站内信标题长度上限。 */
export const ANNOUNCEMENT_TITLE_MAX = 80;
/** 站内信正文长度上限。 */
export const ANNOUNCEMENT_BODY_MAX = 2000;
/** 通知列表单页上限。 */
export const NOTIFICATION_PAGE_LIMIT = 50;

// ---------- 好友 ----------

/**
 * 两人之间的关系：
 * - self            自己
 * - friends         已经是好友
 * - pending_outgoing 我发出的申请，等对方确认
 * - pending_incoming 对方发来的申请，等我确认
 * - none            还没有任何关系
 */
export const friendRelationSchema = z.enum([
  'self',
  'friends',
  'pending_outgoing',
  'pending_incoming',
  'none',
]);
export type FriendRelation = z.infer<typeof friendRelationSchema>;

/** 好友摘要：只含公开展示信息。 */
export const friendSummarySchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  /** 成为好友的时间 */
  since: z.string(),
  /** 与该好友的会话 id：好友列表点「消息」直接进这个会话 */
  conversationId: z.string().uuid().nullable(),
});

export const friendListResponseSchema = z.object({
  friends: z.array(friendSummarySchema),
});

/**
 * 按邮箱精确查找站内用户（只用于添加好友）。
 * 刻意不做前缀模糊搜索，避免枚举站内邮箱。
 */
export const friendSearchRequestSchema = z.object({
  email: z.string().trim().min(3).max(254),
});

export const friendSearchResponseSchema = z.object({
  found: z.boolean(),
  userId: z.string().nullable(),
  nickname: z.string().nullable(),
  relation: friendRelationSchema,
});

/** 发送好友申请（申请-同意制：对方同意后才成为好友）。 */
export const friendRequestCreateRequestSchema = z.object({
  email: z.string().trim().min(3).max(254),
  message: z.string().trim().max(FRIEND_REQUEST_MESSAGE_MAX).optional(),
});

export const friendRequestCreateResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: z.literal('pending'),
});

/** 好友申请条目：incoming = 等我处理；outgoing = 等对方处理。 */
export const friendRequestItemSchema = z.object({
  requestId: z.string().uuid(),
  direction: z.enum(['incoming', 'outgoing']),
  /** 对方（相对当前用户）：收到的申请里是发起人，发出的申请里是接收人 */
  userId: z.string(),
  nickname: z.string(),
  message: z.string().nullable(),
  status: z.enum(['pending', 'accepted', 'rejected', 'canceled']),
  createdAt: z.string(),
});

export const friendRequestListResponseSchema = z.object({
  requests: z.array(friendRequestItemSchema),
});

/** 处理好友申请：同意或拒绝。 */
export const friendRequestReviewRequestSchema = z.object({
  accept: z.boolean(),
});

export const friendRequestReviewResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(['accepted', 'rejected']),
});

// ---------- 私聊 ----------

/** 私聊消息类型：text 普通文本；room_invite 是「来一局」生成的邀请卡片。 */
export const dmMessageKindSchema = z.enum(['text', 'room_invite']);
export type DmMessageKind = z.infer<typeof dmMessageKindSchema>;

/** 房间状态：卡片按它决定按钮是「进入房间」还是「房间已结束」。 */
export const roomStatusSchema = z.enum(['waiting', 'playing', 'closed']);
export type RoomStatus = z.infer<typeof roomStatusSchema>;

export const dmMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  /** 会话内递增序号：已读水位按它算 */
  seq: z.number().int(),
  senderUserId: z.string(),
  senderNickname: z.string(),
  kind: dmMessageKindSchema,
  text: z.string(),
  /** kind='room_invite' 时指向开局房间 */
  roomId: z.string().uuid().nullable(),
  /** kind='room_invite' 时：房间当前状态（null = 房间已不存在） */
  roomStatus: roomStatusSchema.nullable(),
  /** kind='room_invite' 时：邀请链接的令牌明文（拼 /room/invite/:token） */
  inviteToken: z.string().nullable(),
  /** kind='room_invite' 时：对方是否已经进房 */
  peerJoined: z.boolean(),
  createdAt: z.string(),
});

export const dmMessageListResponseSchema = z.object({
  messages: z.array(dmMessageSchema),
});

export const dmSendRequestSchema = z.object({
  text: z.string().trim().min(1).max(DM_TEXT_MAX),
});

export const dmSendResponseSchema = z.object({
  message: dmMessageSchema,
});

/** 会话列表条目。 */
export const conversationSummarySchema = z.object({
  conversationId: z.string().uuid(),
  peerUserId: z.string(),
  peerNickname: z.string(),
  lastMessage: z
    .object({
      text: z.string(),
      senderUserId: z.string(),
      kind: dmMessageKindSchema,
      createdAt: z.string(),
    })
    .nullable(),
  unreadCount: z.number().int().nonnegative(),
});

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});

/** 会话详情：聊天页顶栏显示对方昵称用。 */
export const conversationDetailSchema = z.object({
  conversationId: z.string().uuid(),
  peerUserId: z.string(),
  peerNickname: z.string(),
});

export const conversationDetailResponseSchema = z.object({
  conversation: conversationDetailSchema,
});

/**
 * 推进已读水位：省略 lastReadSeq 表示「整段会话已读」。
 * 水位只前进不后退（服务端取两者较大值）。
 */
export const dmReadRequestSchema = z.object({
  lastReadSeq: z.number().int().nonnegative().optional(),
});

export const dmReadResponseSchema = z.object({
  lastReadSeq: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
});

// ---------- 快捷开局 ----------

/**
 * 「来一局」：在私聊里开一局并给对方发一张邀请卡片。
 * 对方不是自动进房：卡片上的「进入房间」是邀请链接，对方点了才进。
 * puzzleId 省略时由服务端随机挑一道已发布题目。
 */
export const quickRoomRequestSchema = z.object({
  puzzleId: z.string().uuid().optional(),
  language: languageSchema.default('zh'),
});

export const quickRoomResponseSchema = z.object({
  roomId: z.string().uuid(),
  /** 房间邀请令牌明文（只返回这一次，落在私聊卡片里） */
  inviteToken: z.string(),
  /** 落在私聊里的邀请卡片消息 */
  message: dmMessageSchema,
});

// ---------- 通知与站内信 ----------

export const notificationTypeSchema = z.enum([
  'dm',
  'friend_request',
  'friend_accepted',
  'room_invite',
  'announcement',
  'system',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  title: z.string(),
  body: z.string().nullable(),
  /** 前端跳转路径（站内相对路径），null 表示没有可跳的地方 */
  link: z.string().nullable(),
  actorUserId: z.string().nullable(),
  actorNickname: z.string().nullable(),
  conversationId: z.string().uuid().nullable(),
  roomId: z.string().uuid().nullable(),
  announcementId: z.string().uuid().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const notificationListResponseSchema = z.object({
  notifications: z.array(notificationSchema),
});

export const notificationUnreadResponseSchema = z.object({
  unread: z.number().int().nonnegative(),
});

/** 标记已读：给具体 id 列表，或 all=true 全部已读。 */
export const notificationReadRequestSchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
  all: z.boolean().optional(),
});

export const notificationReadResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
});

/** 管理员群发站内信。 */
export const announcementCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
  body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
});

export const announcementSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  createdBy: z.string(),
  publishedAt: z.string(),
  /** 本条站内信送达的用户数 */
  recipientCount: z.number().int().nonnegative(),
});

export const announcementCreateResponseSchema = z.object({
  id: z.string().uuid(),
  recipientCount: z.number().int().nonnegative(),
});

export const announcementListResponseSchema = z.object({
  announcements: z.array(announcementSchema),
});
