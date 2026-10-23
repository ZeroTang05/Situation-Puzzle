/**
 * 社交域共享查询：昵称批量查询、好友关系判定、通知落库与展示文案。
 *
 * 「语言不落库」是本项目的硬约定，所以通知标题不在库里写死：
 * 库里只存类型与正文投影，读取时按阅读者当前语言即时拼装标题。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { friendRequests, friendships, notifications, profiles, user } from '@jev/database';
import type { Tx } from '@jev/database';
import { displayNickname, normalizeUserPair } from '@jev/domain';
import type { FriendRelation, Language, NotificationType } from '@jev/contracts';
import { app } from '../context.js';

/** 批量查昵称（profiles 表）；查不到时回退到用户 id 前 8 位，不留空白行。 */
export async function nicknamesOf(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await app().db.db
    .select({ userId: profiles.userId, nickname: profiles.nickname })
    .from(profiles)
    .where(inArray(profiles.userId, unique));
  const map = new Map(rows.map((row) => [row.userId, row.nickname]));
  return map;
}

/** 按邮箱精确查站内用户（只用于添加好友，不做前缀模糊搜索）。 */
export async function findUserByEmail(email: string): Promise<{ id: string; nickname: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await app().db.db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalized}`)
    .limit(1);
  const found = rows[0];
  if (!found) return null;
  const nicknames = await nicknamesOf([found.id]);
  return { id: found.id, nickname: displayNickname(nicknames.get(found.id), found.id) };
}

/** 我与对方是否已是好友（好友关系是双向两行，只看 user_id = 我 这一侧）。 */
export async function isFriend(userId: string, peerUserId: string): Promise<boolean> {
  const rows = await app().db.db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(and(eq(friendships.userId, userId), eq(friendships.friendUserId, peerUserId)))
    .limit(1);
  return rows.length > 0;
}

/** 两人之间当前待审申请的发起人（null = 没有待审申请）。 */
export async function pendingRequesterBetween(a: string, b: string): Promise<string | null> {
  const { userLow, userHigh } = normalizeUserPair(a, b);
  const rows = await app().db.db
    .select({ requesterUserId: friendRequests.requesterUserId })
    .from(friendRequests)
    .where(
      and(
        eq(friendRequests.userLow, userLow),
        eq(friendRequests.userHigh, userHigh),
        eq(friendRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return rows[0]?.requesterUserId ?? null;
}

/** 两人之间的关系（搜索结果用）：自己 / 好友 / 待审申请 / 陌生。 */
export async function relationOf(selfId: string, targetId: string): Promise<FriendRelation> {
  if (selfId === targetId) return 'self';
  if (await isFriend(selfId, targetId)) return 'friends';
  const pending = await pendingRequesterBetween(selfId, targetId);
  if (pending === null) return 'none';
  return pending === selfId ? 'pending_outgoing' : 'pending_incoming';
}

/**
 * 通知落库：只存展示所需投影，不复制被提醒对象的完整内容。
 * 必须跟着业务事务一起提交：业务回滚时通知也要一起回滚。
 */
export async function insertNotification(
  tx: Tx,
  input: {
    userId: string;
    type: NotificationType;
    /** 正文投影：私聊摘录 / 申请附言 / 站内信正文；null 表示没有正文 */
    body?: string | null;
    actorUserId?: string | null;
    conversationId?: string | null;
    roomId?: string | null;
    announcementId?: string | null;
    /** 站内信直接用公告标题（其余类型在读取时即时拼装） */
    title?: string | null;
    link?: string | null;
  },
): Promise<void> {
  await tx.insert(notifications).values({
    userId: input.userId,
    type: input.type,
    title: input.title ?? null,
    body: input.body ?? null,
    actorUserId: input.actorUserId ?? null,
    conversationId: input.conversationId ?? null,
    roomId: input.roomId ?? null,
    announcementId: input.announcementId ?? null,
    link: input.link ?? null,
  });
}

/** 通知标题：按阅读者当前语言即时拼装（库里不存语言相关文案）。 */
const notificationTitles = {
  zh: {
    dm: (name: string) => `${name} 发来一条消息`,
    friend_request: (name: string) => `${name} 申请加你为好友`,
    friend_accepted: (name: string) => `${name} 通过了你的好友申请`,
    room_invite: (name: string) => `${name} 开了一局，点进去就能玩`,
    announcement: () => '站内信',
    system: () => '系统通知',
  },
  en: {
    dm: (name: string) => `${name} sent you a message`,
    friend_request: (name: string) => `${name} wants to be your friend`,
    friend_accepted: (name: string) => `${name} accepted your friend request`,
    room_invite: (name: string) => `${name} started a game. Jump in.`,
    announcement: () => 'Announcement',
    system: () => 'System notice',
  },
} as const;

/** 拼装通知标题：库里有标题（站内信）就用库里的，否则按类型即时生成。 */
export function notificationTitle(input: {
  type: NotificationType;
  storedTitle: string | null;
  actorNickname: string | null;
  language: Language;
}): string {
  if (input.storedTitle && input.storedTitle.length > 0) return input.storedTitle;
  const name = input.actorNickname ?? '';
  const table = notificationTitles[input.language];
  switch (input.type) {
    case 'dm':
      return table.dm(name);
    case 'friend_request':
      return table.friend_request(name);
    case 'friend_accepted':
      return table.friend_accepted(name);
    case 'room_invite':
      return table.room_invite(name);
    case 'announcement':
      return table.announcement();
    case 'system':
      return table.system();
  }
}

/** 通知跳转路径：前端按它决定点通知后去哪。 */
export function notificationLink(input: {
  type: NotificationType;
  conversationId: string | null;
  roomId: string | null;
}): string | null {
  switch (input.type) {
    case 'dm':
    case 'room_invite':
      return input.conversationId ? `/chat/${input.conversationId}` : null;
    case 'friend_request':
    case 'friend_accepted':
      return '/friends';
    case 'announcement':
      return '/notifications';
    case 'system':
      return null;
  }
}
