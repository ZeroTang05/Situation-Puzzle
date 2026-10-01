/**
 * 等待室内存逻辑单测：真 JWT 签名/验签 + vitest 假时钟控制在线窗口与回收。
 * 选题查库、开局事务属数据库路径，由 e2e 覆盖，不在本文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LobbyService } from './lobby.service.js';
import { DomainError } from '@jev/domain';
import type { SessionUser } from '../common/http.js';

const SECRET = new TextEncoder().encode('unit-test-lobby-secret');
const user = (userId: string, nickname = userId): SessionUser => ({
  userId,
  email: `${userId}@example.com`,
  emailVerified: true,
  name: userId,
  nickname,
  roles: [],
  status: 'active',
});

/** 同步调用的错误码断言：DomainError 就地抛出，不吞错 */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `unexpected:${String(e)}`;
  }
  return 'no-error';
};

let service: LobbyService;

beforeEach(() => {
  vi.useFakeTimers();
  service = new LobbyService(() => SECRET);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('房主单例', () => {
  it('未清除内存前重复开房返回同一等待室，解散后再开是新实例', async () => {
    const host = user('host', '房主');
    const first = await service.create(host, 8);
    const second = await service.create(host, 8);
    expect(second.lobbyId).toBe(first.lobbyId);
    expect(second.existing).toBe(true);

    await service.dismiss(host, first.lobbyId);
    const third = await service.create(host, 8);
    expect(third.lobbyId).not.toBe(first.lobbyId);
    expect(third.existing).toBe(false);
  });
});

describe('邀请令牌', () => {
  it('真 JWT 往返拿到等待室预览；换密钥或过期都归一为不存在', async () => {
    const host = user('host', '房主');
    const { inviteToken } = await service.create(host, 4);
    await expect(service.previewByInvite(inviteToken)).resolves.toMatchObject({
      hostNickname: '房主',
      memberCount: 1,
      capacity: 4,
    });

    const stranger = new LobbyService(() => new TextEncoder().encode('other-secret'));
    await expect(stranger.previewByInvite(inviteToken)).rejects.toMatchObject({ code: 'LOBBY_NOT_FOUND' });

    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    await expect(service.previewByInvite(inviteToken)).rejects.toMatchObject({ code: 'LOBBY_NOT_FOUND' });
  });
});

describe('加入与成员状态', () => {
  it('凭邀请加入幂等，快照按加入顺序列出成员', async () => {
    const host = user('host', '房主');
    const guest = user('guest', '玩家');
    const { lobbyId, inviteToken } = await service.create(host, 8);

    await service.join(guest, inviteToken);
    await service.join(guest, inviteToken);
    const snapshot = service.snapshot(host, lobbyId);
    expect(snapshot.members.map((m) => m.nickname)).toEqual(['房主', '玩家']);
    expect(snapshot.members.every((m) => m.online)).toBe(true);
    expect(snapshot.startedRoomId).toBeNull();
  });

  it('轮询刷新心跳：31 秒无心跳显示离线，改名随快照同步', async () => {
    const host = user('host', '房主');
    const guest = user('guest', '旧名');
    const { lobbyId, inviteToken } = await service.create(host, 8);
    await service.join(guest, inviteToken);

    vi.advanceTimersByTime(31_000);
    const snapshot = service.snapshot(user('host', '房主'), lobbyId);
    expect(snapshot.members.find((m) => m.userId === 'host')?.online).toBe(true);
    expect(snapshot.members.find((m) => m.userId === 'guest')?.online).toBe(false);

    const renamed = service.snapshot(user('guest', '新名'), lobbyId);
    expect(renamed.members.find((m) => m.userId === 'guest')?.nickname).toBe('新名');
  });

  it('满员再加入报 LOBBY_FULL', async () => {
    const host = user('host');
    const { inviteToken } = await service.create(host, 2);
    await service.join(user('guest'), inviteToken);
    await expect(service.join(user('late'), inviteToken)).rejects.toMatchObject({ code: 'LOBBY_FULL' });
  });
});

describe('离开、踢人与解散', () => {
  it('非房主离开后失去成员身份，凭原邀请可再次加入', async () => {
    const host = user('host');
    const guest = user('guest');
    const { lobbyId, inviteToken } = await service.create(host, 8);
    await service.join(guest, inviteToken);

    service.leave(guest, lobbyId);
    expect(codeOf(() => service.snapshot(guest, lobbyId))).toBe('FORBIDDEN');

    await service.join(guest, inviteToken);
    expect(service.snapshot(guest, lobbyId).members).toHaveLength(2);
  });

  it('房主离开直接拒绝；只有房主能踢人，被踢者重进报受限', async () => {
    const host = user('host');
    const guest = user('guest');
    const { lobbyId, inviteToken } = await service.create(host, 8);
    await service.join(guest, inviteToken);

    expect(codeOf(() => service.leave(host, lobbyId))).toBe('STATE_CONFLICT');
    expect(codeOf(() => service.kick(guest, lobbyId, host.userId))).toBe('FORBIDDEN');

    service.kick(host, lobbyId, guest.userId);
    expect(codeOf(() => service.snapshot(guest, lobbyId))).toBe('MEMBER_RESTRICTED');
    await expect(service.join(guest, inviteToken)).rejects.toMatchObject({ code: 'MEMBER_RESTRICTED' });
  });

  it('只有房主能解散，解散后成员轮询得到不存在', async () => {
    const host = user('host');
    const guest = user('guest');
    const { lobbyId, inviteToken } = await service.create(host, 8);
    await service.join(guest, inviteToken);

    expect(codeOf(() => service.dismiss(guest, lobbyId))).toBe('FORBIDDEN');
    service.dismiss(host, lobbyId);
    expect(codeOf(() => service.snapshot(host, lobbyId))).toBe('LOBBY_NOT_FOUND');
  });
});

describe('闲置回收', () => {
  it('两小时无人心跳的等待室被 GC，房主名额随之释放', async () => {
    const host = user('host');
    const { lobbyId, inviteToken } = await service.create(host, 8);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    service.gc();

    expect(codeOf(() => service.snapshot(host, lobbyId))).toBe('LOBBY_NOT_FOUND');
    await expect(service.previewByInvite(inviteToken)).rejects.toMatchObject({ code: 'LOBBY_NOT_FOUND' });
    const next = await service.create(host, 8);
    expect(next.existing).toBe(false);
  });

  it('心跳中的等待室不会被 GC', async () => {
    const host = user('host');
    const guest = user('guest');
    const { lobbyId, inviteToken } = await service.create(host, 8);
    await service.join(guest, inviteToken);

    vi.advanceTimersByTime(90 * 60 * 1000);
    service.snapshot(guest, lobbyId); // 心跳
    vi.advanceTimersByTime(90 * 60 * 1000);
    service.gc();

    expect(service.snapshot(host, lobbyId).members).toHaveLength(2);
  });
});

describe('开局前置', () => {
  it('未选题时房主不能开始；非房主一律拒绝', async () => {
    const host = user('host');
    const guest = user('guest');
    const { lobbyId, inviteToken } = await service.create(host, 8);
    await service.join(guest, inviteToken);

    await expect(service.start(guest, lobbyId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.start(host, lobbyId)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
});
