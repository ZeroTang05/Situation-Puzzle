/**
 * 好友 / 私聊 / 快捷开局 / 通知的真实数据库验证：需 SOCIAL_TEST_DATABASE_URL。
 *
 * 覆盖：邮箱搜索 → 申请 → 同意（双向好友关系 + 会话）→ 反向申请互斥 →
 * 重复处理申请 → 私聊消息与序号 → 已读水位只前进 → 快捷开局（邀请卡片，对方点链接才进房）→
 * 站内信群发。
 * 用独立临时库跑（迁移脚本写死 public schema），结束后整库删除，不碰其它库的数据。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as schemaModule from '@jev/database/schema';
import type { DbHandle } from '@jev/database';
import { setAppContext } from '../context.js';
import { FriendsService } from './friends.service.js';
import { ChatService } from './chat.service.js';
import { NotificationsService } from './notifications.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import type { SessionUser } from '../common/http.js';

const databaseUrl = process.env.SOCIAL_TEST_DATABASE_URL;

describe.runIf(!!databaseUrl)('好友 / 私聊 / 通知（真实数据库）', () => {
  const dbName = `jev_social_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let handle: DbHandle;
  const friends = new FriendsService();
  const chat = new ChatService();
  const notifications = new NotificationsService();
  const rooms = new RoomsService();

  const alice = session('alice', '阿离');
  const bob = session('bob', '小博');
  const carol = session('carol', '卡罗');

  beforeAll(async () => {
    const base = new URL(databaseUrl!);
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    control = new Pool({ connectionString: adminUrl.toString() });
    await control.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await control.query(`CREATE DATABASE "${dbName}"`);

    const testUrl = new URL(base);
    testUrl.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });

    const db = drizzle(pool, { schema: schemaModule });
    // 真正的 drizzle 迁移器：顺带验证 0014_friends_dm_notifications.sql 能干净落地
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });

    handle = { db, pool, tx: (fn) => db.transaction(fn as never) as never, close: () => pool.end() };
    setAppContext({
      db: handle,
      jev: { model: 'test-model', promptVersion: 'v-test', threshold: 0.5, language: 'zh' },
      queue: {
        async sendJob() { return null; },
        async sendInTx() { return 'job'; },
        async close() {},
      },
      realtime: { dropUserFromRoom() {}, broadcastLobbyStarted() {} },
    } as never);

    await seed();
  }, 120_000);

  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      if (control) {
        try {
          await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } finally {
          await control.end();
        }
      }
    }
  }, 60_000);

  function session(id: string, nickname: string): SessionUser {
    return { userId: id, email: `${id}@example.com`, emailVerified: true, name: nickname, nickname, roles: [], status: 'active' };
  }

  async function seed() {
    for (const u of [alice, bob, carol]) {
      await handle.db.insert(schemaModule.user).values({ id: u.userId, name: u.nickname, email: u.email, emailVerified: true });
      await handle.db.insert(schemaModule.profiles).values({ userId: u.userId, nickname: u.nickname });
      // 快捷开局要消耗开房额度：两个人都要有免费账户
      await handle.db.insert(schemaModule.freeRoomAccounts).values({ userId: u.userId, total: 10 });
    }
    const [puzzle] = await handle.db.insert(schemaModule.puzzles).values({ source: 'official' }).returning();
    const [version] = await handle.db.insert(schemaModule.puzzleVersions).values({
      puzzleId: puzzle!.id,
      versionNo: 1,
      language: 'zh',
      title: '测试题',
      surface: '汤面',
      answer: '这是汤底',
      hints: ['提示一'],
      moderationStatus: 'published',
    }).returning();
    // 当前发布版指针：题库按它取「现在能玩的这一版」
    await handle.db.update(schemaModule.puzzles)
      .set({ currentPublishedVersionId: version!.id })
      .where(eq(schemaModule.puzzles.id, puzzle!.id));
  }

  // ---------- 好友 ----------

  it('按邮箱精确搜索：找到用户并给出当前关系', async () => {
    const found = await friends.search(alice, 'bob@example.com');
    expect(found.found).toBe(true);
    expect(found.userId).toBe(bob.userId);
    expect(found.nickname).toBe('小博');
    expect(found.relation).toBe('none');

    const missing = await friends.search(alice, 'nobody@example.com');
    expect(missing.found).toBe(false);
    expect(missing.relation).toBe('none');
  });

  it('搜索自己时关系是 self', async () => {
    const found = await friends.search(alice, 'alice@example.com');
    expect(found.relation).toBe('self');
  });

  it('发申请后：对方能看到待审申请，发起方看到的是 outgoing', async () => {
    await friends.createRequest(alice, 'bob@example.com', '一起玩一局？');
    const incoming = await friends.listRequests(bob);
    const pending = incoming.requests.find((r) => r.direction === 'incoming');
    expect(pending?.userId).toBe(alice.userId);
    expect(pending?.message).toBe('一起玩一局？');
    expect(pending?.status).toBe('pending');

    const outgoing = await friends.listRequests(alice);
    expect(outgoing.requests.find((r) => r.direction === 'outgoing')?.userId).toBe(bob.userId);

    // 对方给我发了申请之后，我再反向发会被拒（双向互斥）
    await expect(friends.createRequest(bob, 'alice@example.com')).rejects.toThrow(/已经申请/);
  });

  it('申请-同意：建立双向好友关系并建会话', async () => {
    const incoming = await friends.listRequests(bob);
    const request = incoming.requests.find((r) => r.direction === 'incoming')!;
    const result = await friends.reviewRequest(bob, request.requestId, true);
    expect(result.status).toBe('accepted');

    const rows = await handle.db.select().from(schemaModule.friendships);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.userId}->${r.friendUserId}`).sort()).toEqual(
      [`${alice.userId}->${bob.userId}`, `${bob.userId}->${alice.userId}`].sort(),
    );

    const conversations = await handle.db.select().from(schemaModule.conversations);
    expect(conversations).toHaveLength(1);

    // 好友列表带会话 id：好友页点「消息」直接进这个会话
    const friendList = await friends.list(alice);
    expect(friendList.friends[0]!.conversationId).toBe(conversations[0]!.id);

    // 已经是好友就不能再申请
    await expect(friends.createRequest(alice, 'bob@example.com')).rejects.toThrow(/已经是好友/);
  });

  it('同一条申请不能处理两次', async () => {
    const incoming = await friends.listRequests(bob);
    const request = incoming.requests.find((r) => r.direction === 'incoming')!;
    await expect(friends.reviewRequest(bob, request.requestId, true)).rejects.toThrow(/已经处理过/);
  });

  it('非申请接收方不能处理申请', async () => {
    const created = await friends.createRequest(alice, 'carol@example.com');
    // bob 是无关第三方：不能处理 alice 与 carol 之间的申请
    await expect(friends.reviewRequest(bob, created.requestId, true)).rejects.toThrow(/只有收到申请的人/);
    // 发起人自己也不能处理
    await expect(friends.reviewRequest(alice, created.requestId, true)).rejects.toThrow(/只有收到申请的人/);
  });

  it('撤回自己发出的申请', async () => {
    const outgoing = await friends.listRequests(alice);
    const request = outgoing.requests.find((r) => r.direction === 'outgoing' && r.status === 'pending')!;
    await friends.cancelRequest(alice, request.requestId);
    const after = await friends.listRequests(alice);
    expect(after.requests.find((r) => r.requestId === request.requestId)?.status).toBe('canceled');
  });

  it('删好友：双向两行一起删', async () => {
    await friends.removeFriend(alice, bob.userId);
    const rows = await handle.db.select().from(schemaModule.friendships);
    expect(rows).toHaveLength(0);
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    const beforeMessages = await handle.db.select().from(schemaModule.dmMessages);
    const beforeNotifications = await handle.db.select().from(schemaModule.notifications);
    const beforeRooms = await handle.db.select().from(schemaModule.rooms);
    for (const sender of [alice, bob]) {
      await expect(chat.sendMessage(sender, conversationId, '删除后发送')).rejects.toMatchObject({ code: 'NOT_FRIENDS' });
      await expect(chat.startQuickRoom(sender, conversationId, undefined, 'zh')).rejects.toMatchObject({ code: 'NOT_FRIENDS' });
    }
    expect(await handle.db.select().from(schemaModule.dmMessages)).toEqual(beforeMessages);
    expect(await handle.db.select().from(schemaModule.notifications)).toEqual(beforeNotifications);
    expect(await handle.db.select().from(schemaModule.rooms)).toEqual(beforeRooms);
    expect((await chat.listMessages(alice, conversationId)).messages).toEqual([]);

    // 重新通过真实好友申请恢复关系，后面的正常收发继续复用原会话。
    const request = await friends.createRequest(alice, bob.email, '重新添加');
    await friends.reviewRequest(bob, request.requestId, true);
    expect(await handle.db.select().from(schemaModule.conversations)).toHaveLength(1);
  });

  // ---------- 私聊 ----------

  it('发消息：序号递增，对方收到通知', async () => {
    const conversations = await handle.db.select().from(schemaModule.conversations);
    const conversationId = conversations[0]!.id;

    const first = await chat.sendMessage(alice, conversationId, '在吗');
    expect(first.message.seq).toBe(1);
    const second = await chat.sendMessage(bob, conversationId, '在');
    expect(second.message.seq).toBe(2);

    const unread = await notifications.unreadCount(bob);
    expect(unread.unread).toBeGreaterThanOrEqual(1);

    const list = await notifications.list(bob, 'zh', 50);
    const dm = list.notifications.find((n) => n.type === 'dm');
    expect(dm?.title).toContain('阿离');
  });

  it('已读水位只前进不后退', async () => {
    const conversations = await handle.db.select().from(schemaModule.conversations);
    const conversationId = conversations[0]!.id;

    const read = await chat.markRead(bob, conversationId, 2);
    expect(read.lastReadSeq).toBe(2);
    expect(read.unreadCount).toBe(0);

    // 用更小的序号再读一次：水位不能倒退
    const back = await chat.markRead(bob, conversationId, 1);
    expect(back.lastReadSeq).toBe(2);
  });

  it('自己发的消息不算未读', async () => {
    const conversations = await handle.db.select().from(schemaModule.conversations);
    const conversationId = conversations[0]!.id;

    // bob 发一条（自己发的不算未读），alice 再发一条（算一条未读）
    await chat.sendMessage(bob, conversationId, '我也说一句');
    await chat.sendMessage(alice, conversationId, '你回一句');
    const list = await chat.listConversations(bob);
    expect(list.conversations[0]!.unreadCount).toBe(1);
  });

  it('会话列表带未读数与对方昵称', async () => {
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    // 先把已有消息读干净，再让 alice 发一条：未读数应当正好是 1
    await chat.markRead(bob, conversationId);
    await chat.sendMessage(alice, conversationId, '第三条');
    const list = await chat.listConversations(bob);
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]!.peerNickname).toBe('阿离');
    expect(list.conversations[0]!.unreadCount).toBe(1);
    expect(list.conversations[0]!.lastMessage?.text).toBe('第三条');
  });

  it('不是会话成员不能读写', async () => {
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    await expect(chat.sendMessage(carol, conversationId, '偷看')).rejects.toThrow(/不在这个会话/);
    await expect(chat.listMessages(carol, conversationId)).rejects.toThrow(/不在这个会话/);
  });

  // ---------- 快捷开局 ----------

  it('来一局：只发起一局并发邀请卡片，对方点链接才进房', async () => {
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    const result = await chat.startQuickRoom(alice, conversationId, undefined, 'zh');
    expect(result.roomId).toBeTruthy();
    expect(result.inviteToken).toBeTruthy();
    expect(result.message.kind).toBe('room_invite');
    expect(result.message.roomId).toBe(result.roomId);
    expect(result.message.inviteToken).toBe(result.inviteToken);
    expect(result.message.roomStatus).toBe('playing');
    expect(result.message.peerJoined).toBe(false);

    // 对方没有被自动拉进房间：只有发起人是成员与本局参与者
    const members = await handle.db.select().from(schemaModule.roomMembers)
      .where(eq(schemaModule.roomMembers.roomId, result.roomId));
    expect(members.map((m) => m.userId)).toEqual([alice.userId]);

    const participants = await handle.db.select().from(schemaModule.roundParticipants);
    expect(participants).toHaveLength(1);

    const [room] = await handle.db.select().from(schemaModule.rooms).where(eq(schemaModule.rooms.id, result.roomId));
    expect(room?.status).toBe('playing');
    // 快捷开局是私人房间：不出现在大厅
    expect(room?.isPublic).toBe(false);

    // 通知里的链接是邀请链接：对方还不是成员，只能走这个链接进房
    const list = await notifications.list(bob, 'zh', 50);
    const invite = list.notifications.find((n) => n.type === 'room_invite');
    expect(invite?.link).toBe(`/room/invite/${result.inviteToken}`);

    // 对方点了邀请链接才进房
    const joined = await rooms.joinRoom(bob, result.inviteToken);
    expect(joined.roomId).toBe(result.roomId);
    const afterMembers = await handle.db.select().from(schemaModule.roomMembers)
      .where(eq(schemaModule.roomMembers.roomId, result.roomId));
    expect(afterMembers.map((m) => m.userId).sort()).toEqual([alice.userId, bob.userId].sort());
    const afterParticipants = await handle.db.select().from(schemaModule.roundParticipants);
    expect(afterParticipants).toHaveLength(2);

    // 卡片按房间当前状态渲染：对方已进房
    const messages = await chat.listMessages(bob, conversationId);
    const card = messages.messages.find((m) => m.kind === 'room_invite');
    expect(card?.roomStatus).toBe('playing');
    expect(card?.peerJoined).toBe(true);
  });

  it('房间归档后邀请卡片变成「房间已结束」', async () => {
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    const result = await chat.startQuickRoom(alice, conversationId, undefined, 'zh');
    await handle.db.update(schemaModule.rooms)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(schemaModule.rooms.id, result.roomId));
    const messages = await chat.listMessages(alice, conversationId);
    const card = messages.messages.find((m) => m.kind === 'room_invite' && m.roomId === result.roomId);
    expect(card?.roomStatus).toBe('closed');
    // 房间关了，邀请链接就该失效
    await expect(rooms.joinRoom(bob, result.inviteToken)).rejects.toThrow(/房间已关闭/);
  });

  it('非会话成员不能发起快捷开局', async () => {
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    await expect(chat.startQuickRoom(carol, conversationId, undefined, 'zh')).rejects.toThrow(/不在这个会话/);
  });

  // ---------- 站内信 ----------

  it('站内信群发：每个 active 用户一条通知', async () => {
    const operator = { ...alice, roles: ['admin'] } as SessionUser;
    const result = await notifications.publishAnnouncement(operator, '服务器维护', '今晚 23:00 维护十分钟。');
    expect(result.recipientCount).toBe(3);

    const list = await notifications.list(bob, 'zh', 50);
    const announcement = list.notifications.find((n) => n.type === 'announcement');
    expect(announcement?.title).toBe('服务器维护');
    expect(announcement?.body).toBe('今晚 23:00 维护十分钟。');
  });

  it('标记已读：只影响自己的通知', async () => {
    const before = await notifications.unreadCount(bob);
    expect(before.unread).toBeGreaterThan(0);
    const updated = await notifications.markRead(bob, { all: true });
    expect(updated.updated).toBe(before.unread);
    const after = await notifications.unreadCount(bob);
    expect(after.unread).toBe(0);
    // 别人的通知不受影响
    const aliceUnread = await notifications.unreadCount(alice);
    expect(aliceUnread.unread).toBeGreaterThan(0);
  });
  it('删除与发送并发：撤权提交后消息和邀请均拒绝，历史保留', async () => {
    const conversationId = (await handle.db.select().from(schemaModule.conversations))[0]!.id;
    const before = await chat.listMessages(alice, conversationId);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      const removal = friends.removeFriend(alice, bob.userId);
      await waitForLocks(1);
      const writes = Promise.allSettled([
        chat.sendMessage(alice, conversationId, '并发消息'),
        chat.startQuickRoom(bob, conversationId, undefined, 'zh'),
      ]);
      await waitForLocks(3);
      await blocker.query('COMMIT');
      await removal;
      const outcomes = await writes;
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') expect(outcome.reason.code).toBe('NOT_FRIENDS');
      }
      expect(await chat.listMessages(alice, conversationId)).toEqual(before);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  /** 用真实 PostgreSQL 锁等待确认先后顺序，不依赖固定延时。 */
  async function waitForLocks(count: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND query LIKE '%"conversations"%'`,
      );
      if (result.rows[0].n >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('等待会话行锁超时');
  }

});
