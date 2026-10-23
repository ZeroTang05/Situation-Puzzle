/**
 * 通知服务：通知中心（未读计数 + 列表 + 标记已读）与站内信群发。
 *
 * 通知类型覆盖私聊提醒、好友申请、快捷开局邀请与站内信。
 * 站内信发布时给每个 active 用户落一条通知（用户量不大，直接展开即可）。
 *
 * 语言不落库：通知标题在读取时按阅读者当前语言即时拼装（见 social.repository.ts）。
 */
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { announcements, notifications, profiles } from '@jev/database';
import { DomainError, displayNickname } from '@jev/domain';
import type { Language, NotificationType } from '@jev/contracts';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';
import { nicknamesOf, notificationLink, notificationTitle } from './social.repository.js';
import { orderBySort } from '../admin/admin-sort.js';
import { ANNOUNCEMENT_SORT } from '../admin/admin-sort-columns.js';

@Injectable()
export class NotificationsService {
  private get db() {
    return app().db;
  }

  /** 通知列表：最新在前。 */
  async list(user: SessionUser, language: Language, limit: number): Promise<{
    notifications: Array<{
      id: string;
      type: NotificationType;
      title: string;
      body: string | null;
      link: string | null;
      actorUserId: string | null;
      actorNickname: string | null;
      conversationId: string | null;
      roomId: string | null;
      announcementId: string | null;
      readAt: string | null;
      createdAt: string;
    }>;
  }> {
    const rows = await this.db.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    const actorIds = rows.map((row) => row.actorUserId).filter((id): id is string => id !== null);
    const nicknames = await nicknamesOf(actorIds);

    return {
      notifications: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: notificationTitle({
          type: row.type,
          storedTitle: row.title,
          actorNickname: row.actorUserId ? displayNickname(nicknames.get(row.actorUserId), row.actorUserId) : null,
          language,
        }),
        body: row.body,
        link: row.link ?? notificationLink({ type: row.type, conversationId: row.conversationId, roomId: row.roomId }),
        actorUserId: row.actorUserId,
        actorNickname: row.actorUserId ? displayNickname(nicknames.get(row.actorUserId), row.actorUserId) : null,
        conversationId: row.conversationId,
        roomId: row.roomId,
        announcementId: row.announcementId,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** 未读计数（铃铛角标）。 */
  async unreadCount(user: SessionUser): Promise<{ unread: number }> {
    const [row] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.userId), isNull(notifications.readAt)));
    return { unread: row?.n ?? 0 };
  }

  /** 标记已读：给具体 id 列表，或 all=true 全部已读。只影响自己的通知。 */
  async markRead(user: SessionUser, input: { ids?: string[]; all?: boolean }): Promise<{ updated: number }> {
    const now = new Date();
    if (input.all) {
      const updated = await this.db.db
        .update(notifications)
        .set({ readAt: now })
        .where(and(eq(notifications.userId, user.userId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      return { updated: updated.length };
    }
    const ids = input.ids ?? [];
    if (ids.length === 0) return { updated: 0 };
    const updated = await this.db.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.userId, user.userId),
          inArray(notifications.id, ids),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return { updated: updated.length };
  }

  /**
   * 发布站内信：给每个 active 用户落一条通知。
   * 站内信的标题与正文原样保存（管理员写什么就是什么），不受界面语言影响。
   */
  async publishAnnouncement(
    operator: SessionUser,
    title: string,
    body: string,
  ): Promise<{ id: string; recipientCount: number }> {
    return this.db.tx(async (tx) => {
      const [announcement] = await tx
        .insert(announcements)
        .values({ title, body, createdBy: operator.userId })
        .returning({ id: announcements.id });
      if (!announcement) throw new DomainError('INTERNAL', '站内信发布失败');

      const [counted] = await tx
        .select({ n: count() })
        .from(profiles)
        .where(eq(profiles.status, 'active'));
      const recipientCount = counted?.n ?? 0;

      await tx.execute(sql`
        insert into notifications (user_id, type, title, body, announcement_id, link)
        select p.user_id, 'announcement', ${title}, ${body}, ${announcement.id}, '/notifications'
        from profiles p
        where p.status = 'active'
      `);

      return { id: announcement.id, recipientCount };
    });
  }

  /** 后台：站内信列表（可排序）。 */
  async listAnnouncements(input: {
    page: number;
    perPage: number;
    sort?: string;
    order?: string;
  }): Promise<{ items: Array<{ id: string; title: string; body: string; createdBy: string; publishedAt: string; recipientCount: number }>; total: number }> {
    const offset = (input.page - 1) * input.perPage;
    const order = orderBySort(
      input.sort,
      input.order,
      ANNOUNCEMENT_SORT,
      desc(announcements.publishedAt),
      desc(announcements.id),
    );
    const rows = await this.db.db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        createdBy: announcements.createdBy,
        publishedAt: announcements.publishedAt,
      })
      .from(announcements)
      .orderBy(...order)
      .limit(input.perPage)
      .offset(offset);
    const [totaled] = await this.db.db.select({ n: count() }).from(announcements);
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        createdBy: row.createdBy,
        publishedAt: row.publishedAt.toISOString(),
        recipientCount: 0,
      })),
      total: totaled?.n ?? 0,
    };
  }
}
