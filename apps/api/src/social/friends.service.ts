/**
 * 好友服务：申请-同意制（对方同意后才成为好友）。
 *
 * 三条产品口径（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）：
 *  1. A→B 与 B→A 互斥：同一对用户同时最多一条待审申请（数据库部分唯一索引兜底）
 *  2. 邮箱只做精确匹配，不做前缀模糊搜索（避免枚举站内邮箱）
 *  3. 好友关系是双向两行，删好友要删两行
 *
 * 并发：两条申请同时到达时靠 friend_requests_pending_pair_uq 拦住，
 * 捕获唯一冲突后统一回 FRIEND_REQUEST_EXISTS。
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, ne, or } from 'drizzle-orm';
import { conversations, friendRequests, friendships } from '@jev/database';
import {
  DomainError,
  displayNickname,
  friendRequestBlockError,
  friendRequestBlockReason,
  friendResponseBlockError,
  friendResponseBlockReason,
  normalizeUserPair,
} from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';
import { findUserByEmail, insertNotification, nicknamesOf, pendingRequesterBetween, relationOf } from './social.repository.js';

/** PostgreSQL 唯一冲突（23505）。 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

@Injectable()
export class FriendsService {
  private get db() {
    return app().db;
  }

  /** 我的好友列表（按成为好友的时间倒序）。 */
  async list(user: SessionUser): Promise<{ friends: Array<{ userId: string; nickname: string; since: string }> }> {
    const rows = await this.db.db
      .select({ friendUserId: friendships.friendUserId, createdAt: friendships.createdAt })
      .from(friendships)
      .where(eq(friendships.userId, user.userId))
      .orderBy(desc(friendships.createdAt));
    if (rows.length === 0) return { friends: [] };
    const nicknames = await nicknamesOf(rows.map((row) => row.friendUserId));
    return {
      friends: rows.map((row) => ({
        userId: row.friendUserId,
        nickname: displayNickname(nicknames.get(row.friendUserId), row.friendUserId),
        since: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 按邮箱精确查找站内用户：只用于添加好友。
   * 返回我与对方当前的关系，前端据此决定按钮是「加好友」还是「等待确认」。
   */
  async search(user: SessionUser, email: string): Promise<{
    found: boolean;
    userId: string | null;
    nickname: string | null;
    relation: Awaited<ReturnType<typeof relationOf>>;
  }> {
    const target = await findUserByEmail(email);
    if (!target) return { found: false, userId: null, nickname: null, relation: 'none' };
    const relation = await relationOf(user.userId, target.id);
    return { found: true, userId: target.id, nickname: target.nickname, relation };
  }

  /** 发送好友申请：对方同意后才成为好友。 */
  async createRequest(
    user: SessionUser,
    email: string,
    message?: string,
  ): Promise<{ requestId: string; status: 'pending' }> {
    const target = await findUserByEmail(email);
    if (!target) throw new DomainError('USER_NOT_FOUND', '该邮箱未注册，请先让对方注册');

    const isFriend = await this.isFriendRow(user.userId, target.id);
    const pendingRequester = await pendingRequesterBetween(user.userId, target.id);
    const block = friendRequestBlockReason({
      selfId: user.userId,
      targetId: target.id,
      isFriend,
      pendingRequesterUserId: pendingRequester,
    });
    if (block) {
      const error = friendRequestBlockError(block);
      throw new DomainError(error.code, error.message);
    }

    const { userLow, userHigh } = normalizeUserPair(user.userId, target.id);
    return this.db.tx(async (tx) => {
      let requestId: string;
      try {
        const inserted = await tx
          .insert(friendRequests)
          .values({
            userLow,
            userHigh,
            requesterUserId: user.userId,
            status: 'pending',
            message: message && message.length > 0 ? message : null,
          })
          .returning({ id: friendRequests.id });
        requestId = inserted[0]!.id;
      } catch (err) {
        // 并发下另一条申请先落地：部分唯一索引挡住，回同一个错误码
        if (isUniqueViolation(err)) {
          const error = friendRequestBlockError('pending_outgoing');
          throw new DomainError(error.code, error.message);
        }
        throw err;
      }

      await insertNotification(tx, {
        userId: target.id,
        type: 'friend_request',
        body: message && message.length > 0 ? message : null,
        actorUserId: user.userId,
        link: '/friends',
      });

      return { requestId, status: 'pending' as const };
    });
  }

  /**
   * 好友申请列表：收到的（incoming）与发出的（outgoing）都在这里，
   * 前端按 direction 分区展示。
   */
  async listRequests(user: SessionUser): Promise<{
    requests: Array<{
      requestId: string;
      direction: 'incoming' | 'outgoing';
      userId: string;
      nickname: string;
      message: string | null;
      status: 'pending' | 'accepted' | 'rejected' | 'canceled';
      createdAt: string;
    }>;
  }> {
    const rows = await this.db.db
      .select({
        id: friendRequests.id,
        requesterUserId: friendRequests.requesterUserId,
        status: friendRequests.status,
        message: friendRequests.message,
        createdAt: friendRequests.createdAt,
      })
      .from(friendRequests)
      .where(
        or(
          eq(friendRequests.requesterUserId, user.userId),
          and(
            or(eq(friendRequests.userLow, user.userId), eq(friendRequests.userHigh, user.userId)),
            ne(friendRequests.requesterUserId, user.userId),
          ),
        ),
      )
      .orderBy(desc(friendRequests.createdAt))
      .limit(100);

    if (rows.length === 0) return { requests: [] };
    const nicknames = await nicknamesOf(rows.map((row) => row.requesterUserId));
    return {
      requests: rows.map((row) => ({
        requestId: row.id,
        direction: row.requesterUserId === user.userId ? 'outgoing' : 'incoming',
        userId: row.requesterUserId,
        nickname: displayNickname(nicknames.get(row.requesterUserId), row.requesterUserId),
        message: row.message,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 处理好友申请：同意 → 建立双向好友关系；拒绝 → 置终态。
   * 同意时顺带建会话，好友可以直接私聊（会话按规范化的一对唯一）。
   */
  async reviewRequest(
    user: SessionUser,
    requestId: string,
    accept: boolean,
  ): Promise<{ requestId: string; status: 'accepted' | 'rejected' }> {
    return this.db.tx(async (tx) => {
      const [request] = await tx
        .select()
        .from(friendRequests)
        .where(eq(friendRequests.id, requestId))
        .for('update')
        .limit(1);
      if (!request) throw new DomainError('NOT_FOUND', '好友申请不存在');

      const block = friendResponseBlockReason({
        responderId: user.userId,
        targetUserId: request.requesterUserId === request.userLow ? request.userHigh : request.userLow,
        status: request.status,
      });
      if (block) {
        const error = friendResponseBlockError(block);
        throw new DomainError(error.code, error.message);
      }

      const otherUserId = request.requesterUserId === request.userLow ? request.userHigh : request.userLow;
      const now = new Date();

      if (accept) {
        await tx
          .insert(friendships)
          .values([
            { userId: user.userId, friendUserId: otherUserId },
            { userId: otherUserId, friendUserId: user.userId },
          ])
          .onConflictDoNothing();
        // 顺手建会话：好友之间随时能私聊
        const { userLow, userHigh } = normalizeUserPair(user.userId, otherUserId);
        await tx.insert(conversations).values({ userLow, userHigh }).onConflictDoNothing();
        await tx
          .update(friendRequests)
          .set({ status: 'accepted', respondedAt: now })
          .where(eq(friendRequests.id, requestId));
        await insertNotification(tx, {
          userId: otherUserId,
          type: 'friend_accepted',
          actorUserId: user.userId,
          link: '/friends',
        });
        return { requestId, status: 'accepted' as const };
      }

      await tx
        .update(friendRequests)
        .set({ status: 'rejected', respondedAt: now })
        .where(eq(friendRequests.id, requestId));
      return { requestId, status: 'rejected' as const };
    });
  }

  /** 撤回自己发出的申请。 */
  async cancelRequest(user: SessionUser, requestId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [request] = await tx
        .select()
        .from(friendRequests)
        .where(eq(friendRequests.id, requestId))
        .for('update')
        .limit(1);
      if (!request) throw new DomainError('NOT_FOUND', '好友申请不存在');
      if (request.requesterUserId !== user.userId) throw new DomainError('FORBIDDEN', '只能撤回自己发出的申请');
      if (request.status !== 'pending') throw new DomainError('STATE_CONFLICT', '这条申请已经处理过了');
      await tx.update(friendRequests).set({ status: 'canceled', respondedAt: new Date() }).where(eq(friendRequests.id, requestId));
    });
  }

  /** 删除好友：双向两行一起删。 */
  async removeFriend(user: SessionUser, friendUserId: string): Promise<void> {
    await this.db.db
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.userId, user.userId), eq(friendships.friendUserId, friendUserId)),
          and(eq(friendships.userId, friendUserId), eq(friendships.friendUserId, user.userId)),
        ),
      );
  }

  /** 好友关系判定（只看 user_id = 我 这一侧）。 */
  private async isFriendRow(userId: string, friendUserId: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ userId: friendships.userId })
      .from(friendships)
      .where(and(eq(friendships.userId, userId), eq(friendships.friendUserId, friendUserId)))
      .limit(1);
    return rows.length > 0;
  }
}
