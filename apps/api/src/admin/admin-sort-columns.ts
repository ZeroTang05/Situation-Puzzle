/**
 * 后台各列表的排序列白名单。
 *
 * 键 = 后台列表的列名（Datagrid 的 source），值 = drizzle 列或等价 SQL 片段。
 * 派生列（赞踩数、成员数、会员到期、房主昵称）用 SQL 表达式，
 * 与列表 SELECT 共用同一段片段，保证「看到的值」和「排序依据」一致。
 */
import { sql } from 'drizzle-orm';
import { announcements, orders, profiles, puzzleRights, puzzleVersions, puzzles, reports, rooms, user } from '@jev/database';
import type { SortWhitelist } from './admin-sort.js';

/** 赞 / 踩计数：列表与排序共用。 */
export const PUZZLE_UP_COUNT = sql<number>`(select count(*) filter (where r.value = 'up')::int from ratings r where r.puzzle_id = puzzles.id)`;
export const PUZZLE_DOWN_COUNT = sql<number>`(select count(*) filter (where r.value = 'down')::int from ratings r where r.puzzle_id = puzzles.id)`;
/** 生效赞助到期：lifetime=永久，null=无生效赞助。 */
export const USER_SPONSOR_UNTIL = sql<string | null>`(select case when bool_or(g.effective_until is null) then 'lifetime' when max(g.effective_until) > now() then to_char(max(g.effective_until), 'YYYY-MM-DD') else null end from sponsor_grants g where g.user_id = ${user.id} and g.status = 'active')`;
/** 房间成员数：只数 joined 的座位。 */
export const ROOM_MEMBER_COUNT = sql<number>`(select count(*)::int from room_members m where m.room_id = rooms.id and m.status = 'joined')`;
/** 房主昵称：后台直接看到是谁的房。 */
export const ROOM_HOST_NICKNAME = sql<string | null>`(select p.nickname from profiles p where p.user_id = rooms.host_user_id)`;

export const PUZZLE_SORT: SortWhitelist = {
  title: puzzleVersions.title,
  language: puzzleVersions.language,
  versionNo: puzzleVersions.versionNo,
  category: puzzleVersions.category,
  difficulty: puzzleVersions.difficulty,
  status: puzzleVersions.moderationStatus,
  source: puzzles.source,
  unavailable: puzzles.unavailable,
  rightsStatus: puzzleRights.status,
  rightsOrigin: puzzleRights.origin,
  upCount: PUZZLE_UP_COUNT,
  downCount: PUZZLE_DOWN_COUNT,
  createdAt: puzzleVersions.createdAt,
};

export const USER_SORT: SortWhitelist = {
  nickname: profiles.nickname,
  email: user.email,
  emailVerified: user.emailVerified,
  status: profiles.status,
  sponsorUntil: USER_SPONSOR_UNTIL,
  createdAt: profiles.createdAt,
};

export const ROOM_SORT: SortWhitelist = {
  roomId: rooms.id,
  status: rooms.status,
  capacity: rooms.capacity,
  creatorUserId: rooms.creatorUserId,
  hostUserId: rooms.hostUserId,
  hostMode: rooms.hostMode,
  memberCount: ROOM_MEMBER_COUNT,
  hostNickname: ROOM_HOST_NICKNAME,
  closeReason: rooms.closeReason,
  createdAt: rooms.createdAt,
  closedAt: rooms.closedAt,
};

export const REPORT_SORT: SortWhitelist = {
  objectType: reports.objectType,
  objectId: reports.objectId,
  reporterUserId: reports.reporterUserId,
  reason: reports.reason,
  detail: reports.detail,
  status: reports.status,
  createdAt: reports.createdAt,
};

export const ORDER_SORT: SortWhitelist = {
  orderId: orders.id,
  userId: orders.userId,
  status: orders.status,
  amountMinor: orders.amountMinor,
  currency: orders.currency,
  channel: orders.channel,
  merchantOrderNo: orders.merchantOrderNo,
  createdAt: orders.createdAt,
  paidAt: orders.paidAt,
};

/** 站内信（群发公告）列表的排序列。 */
export const ANNOUNCEMENT_SORT: SortWhitelist = {
  id: announcements.id,
  title: announcements.title,
  createdBy: announcements.createdBy,
  publishedAt: announcements.publishedAt,
  createdAt: announcements.createdAt,
};
