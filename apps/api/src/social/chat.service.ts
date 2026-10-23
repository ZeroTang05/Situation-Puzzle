/**
 * 私聊服务：会话列表、消息收发、已读水位、快捷开局（「来一局」）。
 *
 * 送达方式：轮询（聊天页 3 秒、通知角标 10 秒），本轮不动 WebSocket 网关——
 * 实时网关只服务房间事件流，私聊另起一套订阅会牵动房间握手。
 *
 * 已读水位按会话内消息序号推进（不用时间戳：同毫秒发的消息会丢）。
 * 序号在事务里锁会话行后分配，保证同一会话内不重复。
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  appendEvent,
  conversations,
  conversationReads,
  dmMessages,
  puzzles,
  puzzleVersions,
  roomMembers,
  rooms,
  rounds,
  roundParticipants,
} from '@jev/database';
import { DomainError, QUICK_ROOM_CAPACITY, assertCanMessage, displayNickname, nextReadSeq } from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';
import { createRoomWithEntitlementTx, jevConfigVersionOf } from '../rooms/room-creation.js';
import { publishedLanguageJoin } from '../catalog/published-language.js';
import { insertNotification, nicknamesOf } from './social.repository.js';

/** 单次拉取的消息条数上限（聊天页只渲染最近这些）。 */
const MESSAGE_PAGE_SIZE = 100;
/** 通知里私聊摘录的长度上限。 */
const NOTIFICATION_EXCERPT_MAX = 80;

interface DmMessageView {
  id: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderNickname: string;
  kind: 'text' | 'room_invite';
  text: string;
  roomId: string | null;
  createdAt: string;
}

@Injectable()
export class ChatService {
  private get db() {
    return app().db;
  }

  // ---------- 会话列表 ----------

  /** 我的会话列表：按最后一条消息时间倒序（没消息的按会话创建时间）。 */
  async listConversations(user: SessionUser): Promise<{
    conversations: Array<{
      conversationId: string;
      peerUserId: string;
      peerNickname: string;
      lastMessage: { text: string; senderUserId: string; kind: 'text' | 'room_invite'; createdAt: string } | null;
      unreadCount: number;
    }>;
  }> {
    const rows = await this.db.db
      .select({ id: conversations.id, userLow: conversations.userLow, userHigh: conversations.userHigh, createdAt: conversations.createdAt })
      .from(conversations)
      .where(or(eq(conversations.userLow, user.userId), eq(conversations.userHigh, user.userId)));
    if (rows.length === 0) return { conversations: [] };

    const ids = rows.map((row) => row.id);
    const peerOf = new Map(rows.map((row) => [row.id, row.userLow === user.userId ? row.userHigh : row.userLow]));

    // 每个会话的最新消息序号
    const maxSeqRows = await this.db.db
      .select({ conversationId: dmMessages.conversationId, maxSeq: sql<number>`max(${dmMessages.seq})` })
      .from(dmMessages)
      .where(inArray(dmMessages.conversationId, ids))
      .groupBy(dmMessages.conversationId);
    const maxSeqMap = new Map(maxSeqRows.map((row) => [row.conversationId, row.maxSeq]));

    // 最新消息正文
    const lastMessages = new Map<string, typeof dmMessages.$inferSelect>();
    if (maxSeqMap.size > 0) {
      const picked = await this.db.db
        .select()
        .from(dmMessages)
        .where(
          or(
            ...[...maxSeqMap.entries()].map(([conversationId, seq]) =>
              and(eq(dmMessages.conversationId, conversationId), eq(dmMessages.seq, seq)),
            ),
          ),
        );
      for (const message of picked) lastMessages.set(message.conversationId, message);
    }

    // 未读数：消息序号大于我的已读水位
    const unreadRows = await this.db.db
      .select({ conversationId: dmMessages.conversationId, n: sql<number>`count(*)::int` })
      .from(dmMessages)
      .where(
        and(
          inArray(dmMessages.conversationId, ids),
          sql`${dmMessages.seq} > coalesce((select r.last_read_seq from conversation_reads r where r.conversation_id = ${dmMessages.conversationId} and r.user_id = ${user.userId}), 0)`,
        ),
      )
      .groupBy(dmMessages.conversationId);
    const unreadMap = new Map(unreadRows.map((row) => [row.conversationId, row.n]));

    const nicknames = await nicknamesOf([...peerOf.values()]);
    const list = rows.map((row) => {
      const peerUserId = peerOf.get(row.id)!;
      const last = lastMessages.get(row.id);
      return {
        conversationId: row.id,
        peerUserId,
        peerNickname: displayNickname(nicknames.get(peerUserId), peerUserId),
        lastMessage: last
          ? {
              text: last.text,
              senderUserId: last.senderUserId,
              kind: last.kind,
              createdAt: last.createdAt.toISOString(),
            }
          : null,
        unreadCount: unreadMap.get(row.id) ?? 0,
        sortAt: last?.createdAt.getTime() ?? row.createdAt.getTime(),
      };
    });
    list.sort((a, b) => b.sortAt - a.sortAt);
    return { conversations: list.map(({ sortAt: _sortAt, ...rest }) => rest) };
  }

  // ---------- 消息 ----------

  /** 拉会话消息：按序号升序返回最近一批。 */
  async listMessages(user: SessionUser, conversationId: string): Promise<{ messages: DmMessageView[] }> {
    await this.assertParticipant(user.userId, conversationId);
    const rows = await this.db.db
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.conversationId, conversationId))
      .orderBy(desc(dmMessages.seq))
      .limit(MESSAGE_PAGE_SIZE);
    const ordered = rows.reverse();
    const nicknames = await nicknamesOf(ordered.map((row) => row.senderUserId));
    return { messages: ordered.map((row) => this.toView(row, nicknames)) };
  }

  /** 发消息：只有好友能私聊（会话存在即好友，但这里再兜一层）。 */
  async sendMessage(user: SessionUser, conversationId: string, text: string): Promise<{ message: DmMessageView }> {
    return this.db.tx(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update')
        .limit(1);
      if (!conversation) throw new DomainError('NOT_FOUND', '会话不存在');
      const peerUserId = conversation.userLow === user.userId ? conversation.userHigh : conversation.userLow;
      if (conversation.userLow !== user.userId && conversation.userHigh !== user.userId) {
        throw new DomainError('FORBIDDEN', '你不在这个会话里');
      }
      assertCanMessage({ senderId: user.userId, peerId: peerUserId, isFriend: true });

      const [maxRow] = await tx
        .select({ maxSeq: sql<number>`coalesce(max(${dmMessages.seq}), 0)` })
        .from(dmMessages)
        .where(eq(dmMessages.conversationId, conversationId));
      const seq = (maxRow?.maxSeq ?? 0) + 1;

      const [inserted] = await tx
        .insert(dmMessages)
        .values({ conversationId, senderUserId: user.userId, seq, kind: 'text', text })
        .returning();
      if (!inserted) throw new DomainError('INTERNAL', '消息发送失败');

      await insertNotification(tx, {
        userId: peerUserId,
        type: 'dm',
        body: text.length > NOTIFICATION_EXCERPT_MAX ? `${text.slice(0, NOTIFICATION_EXCERPT_MAX)}…` : text,
        actorUserId: user.userId,
        conversationId,
        link: `/chat/${conversationId}`,
      });

      const nicknames = await nicknamesOf([user.userId]);
      return { message: this.toView(inserted, nicknames) };
    });
  }

  /**
   * 推进已读水位：只前进不后退。
   * 省略 lastReadSeq 表示「整段会话已读」。
   */
  async markRead(
    user: SessionUser,
    conversationId: string,
    lastReadSeq?: number,
  ): Promise<{ lastReadSeq: number; unreadCount: number }> {
    await this.assertParticipant(user.userId, conversationId);
    return this.db.tx(async (tx) => {
      const [current] = await tx
        .select({ lastReadSeq: conversationReads.lastReadSeq })
        .from(conversationReads)
        .where(
          and(
            eq(conversationReads.conversationId, conversationId),
            eq(conversationReads.userId, user.userId),
          ),
        )
        .limit(1);
      const currentSeq = current?.lastReadSeq ?? 0;

      let target = lastReadSeq;
      if (target === undefined) {
        const [maxRow] = await tx
          .select({ maxSeq: sql<number>`coalesce(max(${dmMessages.seq}), 0)` })
          .from(dmMessages)
          .where(eq(dmMessages.conversationId, conversationId));
        target = maxRow?.maxSeq ?? 0;
      }
      const next = nextReadSeq(currentSeq, target);

      await tx
        .insert(conversationReads)
        .values({ conversationId, userId: user.userId, lastReadSeq: next })
        .onConflictDoUpdate({
          target: [conversationReads.conversationId, conversationReads.userId],
          set: { lastReadSeq: next },
        });

      const [unread] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(dmMessages)
        .where(and(eq(dmMessages.conversationId, conversationId), sql`${dmMessages.seq} > ${next}`));
      return { lastReadSeq: next, unreadCount: unread?.n ?? 0 };
    });
  }

  // ---------- 快捷开局（来一局） ----------

  /**
   * 一键建房直接开局：建房间 + 建局 + 双方都进房，私聊里落一张开局卡片。
   * 对方点卡片直接进 /rooms/:roomId（两人已是成员，不需要邀请 token）。
   */
  async startQuickRoom(
    user: SessionUser,
    conversationId: string,
    puzzleId: string | undefined,
    language: 'zh' | 'en',
  ): Promise<{ roomId: string; message: DmMessageView }> {
    return this.db.tx(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update')
        .limit(1);
      if (!conversation) throw new DomainError('NOT_FOUND', '会话不存在');
      if (conversation.userLow !== user.userId && conversation.userHigh !== user.userId) {
        throw new DomainError('FORBIDDEN', '你不在这个会话里');
      }
      const peerUserId = conversation.userLow === user.userId ? conversation.userHigh : conversation.userLow;

      // 选题：指定题目就取它的当前发布版，没指定就随机挑一道
      const conditions = [eq(puzzles.unavailable, false), eq(puzzleVersions.language, language)];
      if (puzzleId) conditions.push(eq(puzzles.id, puzzleId));
      const [version] = await tx
        .select({
          puzzleId: puzzles.id,
          versionId: puzzleVersions.id,
          title: puzzleVersions.title,
          surface: puzzleVersions.surface,
          language: puzzleVersions.language,
          category: puzzleVersions.category,
          difficulty: puzzleVersions.difficulty,
          hints: puzzleVersions.hints,
        })
        .from(puzzles)
        .innerJoin(puzzleVersions, publishedLanguageJoin())
        .where(and(...conditions))
        .orderBy(sql`random()`)
        .limit(1);
      if (!version) throw new DomainError('PUZZLE_UNPUBLISHED', '题目不可用或未发布');

      const now = new Date();
      // 房间邀请 token 仍然必填（表结构约束），但两位玩家都已是成员，不需要用它
      const inviteTokenHash = createHash('sha256').update(randomBytes(16)).digest('hex');
      const roomId = await createRoomWithEntitlementTx(tx, {
        creatorUserId: user.userId,
        capacity: QUICK_ROOM_CAPACITY,
        inviteTokenHash,
        now,
        isPublic: false,
      });
      // 对方直接进房
      await tx.insert(roomMembers).values({ roomId, userId: peerUserId, status: 'joined' });

      const [round] = await tx
        .insert(rounds)
        .values({
          roomId,
          roundNo: 1,
          puzzleVersionId: version.versionId,
          language: version.language as 'zh' | 'en',
          jevConfigVersion: jevConfigVersionOf(version.language as 'zh' | 'en'),
        })
        .returning();
      if (!round) throw new DomainError('INTERNAL', '创建本局失败');
      for (const uid of [user.userId, peerUserId]) {
        await tx.insert(roundParticipants).values({ roundId: round.id, userId: uid }).onConflictDoNothing();
      }
      await tx.update(rooms).set({ status: 'playing', lastActivityAt: now }).where(eq(rooms.id, roomId));
      await appendEvent(tx, {
        roomId,
        roundId: round.id,
        type: 'round.started',
        payload: {
          roundId: round.id,
          roundNo: 1,
          puzzleId: version.puzzleId,
          title: version.title,
          surface: version.surface,
          language: version.language,
          category: version.category,
          difficulty: version.difficulty,
          hintsTotal: version.hints.length,
        },
      });

      // 私聊里落一张开局卡片
      const [maxRow] = await tx
        .select({ maxSeq: sql<number>`coalesce(max(${dmMessages.seq}), 0)` })
        .from(dmMessages)
        .where(eq(dmMessages.conversationId, conversationId));
      const seq = (maxRow?.maxSeq ?? 0) + 1;
      const cardText = version.title;
      const [inserted] = await tx
        .insert(dmMessages)
        .values({
          conversationId,
          senderUserId: user.userId,
          seq,
          kind: 'room_invite',
          text: cardText,
          roomId,
        })
        .returning();
      if (!inserted) throw new DomainError('INTERNAL', '开局卡片发送失败');

      await insertNotification(tx, {
        userId: peerUserId,
        type: 'room_invite',
        body: version.title,
        actorUserId: user.userId,
        conversationId,
        roomId,
        link: `/rooms/${roomId}`,
      });

      const nicknames = await nicknamesOf([user.userId]);
      return { roomId, message: this.toView(inserted, nicknames) };
    });
  }

  // ---------- 内部工具 ----------

  /** 会话参与校验：我必须是这两人之一。 */
  private async assertParticipant(userId: string, conversationId: string): Promise<void> {
    const [conversation] = await this.db.db
      .select({ userLow: conversations.userLow, userHigh: conversations.userHigh })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) throw new DomainError('NOT_FOUND', '会话不存在');
    if (conversation.userLow !== userId && conversation.userHigh !== userId) {
      throw new DomainError('FORBIDDEN', '你不在这个会话里');
    }
  }

  /** 消息行的展示投影。 */
  private toView(
    row: typeof dmMessages.$inferSelect,
    nicknames: Map<string, string>,
  ): DmMessageView {
    return {
      id: row.id,
      conversationId: row.conversationId,
      seq: row.seq,
      senderUserId: row.senderUserId,
      senderNickname: displayNickname(nicknames.get(row.senderUserId), row.senderUserId),
      kind: row.kind,
      text: row.text,
      roomId: row.roomId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
