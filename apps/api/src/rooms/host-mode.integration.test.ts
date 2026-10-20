/**
 * 用户主持人模式的真实数据库验证：需 HOST_MODE_TEST_DATABASE_URL。
 *
 * 覆盖：申请 → 房主审批 → 提问挂起（不进 AI 队列）→ 主持人判定 → 退出回落 AI →
 * 主持人汤底可见性 → 房主自申请直接通过。
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
import type { CommandType } from '@jev/contracts';
import { setAppContext } from '../context.js';
import { CommandsService } from './commands.service.js';
import { RoomsService } from './rooms.service.js';
import { LobbyService } from './lobby.service.js';
import type { SessionUser } from '../common/http.js';

const databaseUrl = process.env.HOST_MODE_TEST_DATABASE_URL;

describe.runIf(!!databaseUrl)('用户主持人（真实数据库）', () => {
  const dbName = `jev_host_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let handle: DbHandle;
  const commands = new CommandsService();
  const rooms = new RoomsService();
  /** 记录投递到队列的任务：用户主持模式下提问不应再投给 Jev */
  const dispatched: Array<{ name: string; data: unknown }> = [];

  const owner = session('owner', '房主甲');
  const guest = session('guest', '玩家乙');
  const third = session('third', '玩家丙');

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
    // 真正的 drizzle 迁移器：顺带验证 0012_user_host_mode.sql 能干净落地
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });

    handle = { db, pool, tx: (fn) => db.transaction(fn as never) as never, close: () => pool.end() };
    setAppContext({
      db: handle,
      jev: { model: 'test-model', promptVersion: 'v-test', threshold: 0.5, language: 'zh' },
      queue: {
        async sendJob() { return null; },
        async sendInTx(_tx: unknown, name: string, data: unknown) { dispatched.push({ name, data }); return 'job'; },
        async close() {},
      },
      realtime: { dropUserFromRoom() {}, broadcastLobbyStarted() {} },
    } as never);

    await seed();
  });

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
  });

  function session(id: string, nickname: string): SessionUser {
    return { userId: id, email: `${id}@example.com`, emailVerified: true, name: nickname, nickname, roles: [], status: 'active' };
  }

  async function seed() {
    for (const u of [owner, guest, third]) {
      await handle.db.insert(schemaModule.user).values({ id: u.userId, name: u.nickname, email: u.email, emailVerified: true });
      await handle.db.insert(schemaModule.profiles).values({ userId: u.userId, nickname: u.nickname });
    }
    const [puzzle] = await handle.db.insert(schemaModule.puzzles).values({ source: 'official' }).returning();
    await handle.db.insert(schemaModule.freeRoomAccounts).values({ userId: owner.userId, total: 10 });
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
    const [room] = await handle.db.insert(schemaModule.rooms).values({
      creatorUserId: owner.userId,
      hostUserId: owner.userId,
      inviteTokenHash: `hash-${randomUUID()}`,
      status: 'playing',
    }).returning();
    await handle.db.insert(schemaModule.roomMembers).values([
      { roomId: room!.id, userId: owner.userId, status: 'joined' },
      { roomId: room!.id, userId: guest.userId, status: 'joined' },
      { roomId: room!.id, userId: third.userId, status: 'joined' },
    ]);
    const [round] = await handle.db.insert(schemaModule.rounds).values({
      roomId: room!.id,
      roundNo: 1,
      puzzleVersionId: version!.id,
      language: 'zh',
      jevConfigVersion: 'test-config',
    }).returning();
    await handle.db.insert(schemaModule.roundParticipants).values([
      { roundId: round!.id, userId: owner.userId },
      { roundId: round!.id, userId: guest.userId },
      { roundId: round!.id, userId: third.userId },
    ]);
    seedState.roomId = room!.id;
    seedState.roundId = round!.id;
    seedState.puzzleId = puzzle!.id;
  }

  const seedState = { roomId: '', roundId: '', puzzleId: '', lobbyId: '' };

  const cmd = (type: CommandType, payload: Record<string, unknown> = {}) =>
    commands.handle(owner, seedState.roomId, { clientRequestId: randomUUID(), type, payload });

  it('成员申请成为主持人：进入待审，房间仍是 AI 主持', async () => {
    await commands.handle(guest, seedState.roomId, { clientRequestId: randomUUID(), type: 'request_host', payload: {} });
    const [member] = await handle.db.select().from(schemaModule.roomMembers)
      .where(and(eq(schemaModule.roomMembers.roomId, seedState.roomId), eq(schemaModule.roomMembers.userId, guest.userId)));
    expect(member?.hostRequestedAt).not.toBeNull();
    const [room] = await handle.db.select().from(schemaModule.rooms).where(eq(schemaModule.rooms.id, seedState.roomId));
    expect(room?.hostMode).toBe('ai');
    expect(room?.userHostId).toBeNull();

    const snapshot = await rooms.snapshot(owner, seedState.roomId);
    expect(snapshot.hostRequests.map((r) => r.userId)).toEqual([guest.userId]);
  });

  it('非房主不能审核申请', async () => {
    await expect(commands.handle(third, seedState.roomId, { clientRequestId: randomUUID(), type: 'approve_host', payload: { userId: guest.userId } }))
      .rejects.toThrow(/只有房主/);
  });

  it('房主批准：成员成为用户主持人', async () => {
    await cmd('approve_host', { userId: guest.userId });
    const [room] = await handle.db.select().from(schemaModule.rooms).where(eq(schemaModule.rooms.id, seedState.roomId));
    expect(room?.hostMode).toBe('user');
    expect(room?.userHostId).toBe(guest.userId);
    const [member] = await handle.db.select().from(schemaModule.roomMembers)
      .where(and(eq(schemaModule.roomMembers.roomId, seedState.roomId), eq(schemaModule.roomMembers.userId, guest.userId)));
    expect(member?.role).toBe('user_host');
    expect(member?.hostRequestedAt).toBeNull();

    const snapshot = await rooms.snapshot(owner, seedState.roomId);
    expect(snapshot.members.find((m) => m.userId === guest.userId)?.isUserHost).toBe(true);
    expect(snapshot.hostRequests).toHaveLength(0);
  });

  it('用户主持模式：提问挂起等待主持人，不投给 Jev', async () => {
    dispatched.length = 0;
    await commands.handle(third, seedState.roomId, {
      clientRequestId: randomUUID(), type: 'ask', roundId: seedState.roundId, payload: { text: '他是凶手吗？' },
    });
    expect(dispatched.filter((d) => d.name === 'dispatch-room')).toHaveLength(0);
    const [turn] = await handle.db.select().from(schemaModule.turns).where(eq(schemaModule.turns.roundId, seedState.roundId));
    expect(turn?.status).toBe('queued');
    // 挂起任务没有 deadline：不参与排队超时判定
    expect(turn?.deadlineAt).toBeNull();
  });

  it('非主持人不能回答玩家提问', async () => {
    const [turn] = await handle.db.select().from(schemaModule.turns).where(eq(schemaModule.turns.roundId, seedState.roundId));
    await expect(commands.handle(third, seedState.roomId, {
      clientRequestId: randomUUID(), type: 'host_answer', roundId: seedState.roundId, payload: { turnId: turn!.id, verdict: 'yes' },
    })).rejects.toThrow(/只有本局主持人/);
  });

  it('用户主持人回答：判定写库并广播事件', async () => {
    const [turn] = await handle.db.select().from(schemaModule.turns).where(eq(schemaModule.turns.roundId, seedState.roundId));
    await commands.handle(guest, seedState.roomId, {
      clientRequestId: randomUUID(), type: 'host_answer', roundId: seedState.roundId, payload: { turnId: turn!.id, verdict: 'yes' },
    });
    const [after] = await handle.db.select().from(schemaModule.turns).where(eq(schemaModule.turns.id, turn!.id));
    expect(after?.status).toBe('succeeded');
    expect(after?.result).toBe('yes');
    expect(after?.judgedBy).toBe('host');
    expect(after?.confidence).toBe('1');

    const events = await handle.db.select().from(schemaModule.roomEvents)
      .where(and(eq(schemaModule.roomEvents.roomId, seedState.roomId), eq(schemaModule.roomEvents.type, 'turn.completed')));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { source?: string }).source).toBe('host');
  });

  it('主持人汤底：只有用户主持人可读', async () => {
    const view = await rooms.hostRoundView(guest, seedState.roundId);
    expect(view.answer).toBe('这是汤底');
    await expect(rooms.hostRoundView(third, seedState.roundId)).rejects.toThrow(/只有本局主持人/);
  });

  it('主持人退出：回到 AI 主持并把挂起的提问交还 Jev', async () => {
    // 再问一个问题挂起
    await commands.handle(third, seedState.roomId, {
      clientRequestId: randomUUID(), type: 'ask', roundId: seedState.roundId, payload: { text: '还有别人吗？' },
    });
    dispatched.length = 0;
    await commands.handle(guest, seedState.roomId, { clientRequestId: randomUUID(), type: 'resign_host', payload: {} });
    const [room] = await handle.db.select().from(schemaModule.rooms).where(eq(schemaModule.rooms.id, seedState.roomId));
    expect(room?.hostMode).toBe('ai');
    expect(room?.userHostId).toBeNull();
    expect(dispatched.filter((d) => d.name === 'dispatch-room')).toHaveLength(1);

    // 退出后主持人不能再看汤底
    await expect(rooms.hostRoundView(guest, seedState.roundId)).rejects.toThrow(/只有本局主持人/);
  });

  it('房主自己申请直接通过', async () => {
    await commands.handle(owner, seedState.roomId, { clientRequestId: randomUUID(), type: 'request_host', payload: {} });
    const [room] = await handle.db.select().from(schemaModule.rooms).where(eq(schemaModule.rooms.id, seedState.roomId));
    expect(room?.hostMode).toBe('user');
    expect(room?.userHostId).toBe(owner.userId);
    const [member] = await handle.db.select().from(schemaModule.roomMembers)
      .where(and(eq(schemaModule.roomMembers.roomId, seedState.roomId), eq(schemaModule.roomMembers.userId, owner.userId)));
    expect(member?.role).toBe('user_host');
  });

  it('会客厅：申请 → 批准 → 开局迁移进新房', async () => {
    const lobby = new LobbyService();
    const { lobbyId } = await lobby.openOrGetLobby(owner, 8);
    seedState.lobbyId = lobbyId;
    const { token } = await lobby.createInvite(owner, lobbyId);
    await lobby.join(guest, token);

    // 客人申请：进入待审
    const requested = await lobby.requestHost(guest, lobbyId);
    expect(requested.pending).toBe(true);
    expect(requested.userHostId).toBeNull();

    // 房主批准
    const approved = await lobby.approveHost(owner, lobbyId, guest.userId);
    expect(approved.hostMode).toBe('user');
    expect(approved.userHostId).toBe(guest.userId);
    const snapshot = await lobby.snapshot(owner, lobbyId);
    expect(snapshot.members.find((m) => m.userId === guest.userId)?.isUserHost).toBe(true);

    // 选题后开局：主持状态迁移进新房
    await lobby.select(owner, lobbyId, seedState.puzzleId, 'zh');
    const { roomId } = await lobby.start(owner, lobbyId);
    const [room] = await handle.db.select().from(schemaModule.rooms).where(eq(schemaModule.rooms.id, roomId));
    expect(room?.hostMode).toBe('user');
    expect(room?.userHostId).toBe(guest.userId);
    const [member] = await handle.db.select().from(schemaModule.roomMembers)
      .where(and(eq(schemaModule.roomMembers.roomId, roomId), eq(schemaModule.roomMembers.userId, guest.userId)));
    expect(member?.role).toBe('user_host');
  });

  it('会客厅：主持人可自行退出', async () => {
    const lobby = new LobbyService();
    await lobby.resignHost(guest, seedState.lobbyId);
    const [row] = await handle.db.select().from(schemaModule.userLobbies).where(eq(schemaModule.userLobbies.id, seedState.lobbyId));
    expect(row?.hostMode).toBe('ai');
    expect(row?.userHostId).toBeNull();
  });
});
