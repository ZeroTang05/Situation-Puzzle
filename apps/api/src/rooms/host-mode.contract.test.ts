/**
 * 用户主持人模式的契约回归（17-USER-HOST-MODE）。
 *
 * 钉死三件事：
 *  1. 新命令类型与载荷的 Zod 校验（错误载荷必须在服务端就被拒）；
 *  2. 新房间事件的 payload 形状；
 *  3. 房间/会客厅快照里新增的字段（主持形态、当前主持人、待审申请）。
 */
import { describe, expect, it } from 'vitest';
import {
  commandPayloadSchemas,
  commandTypes,
  hostAskVerdictSchema,
  hostModeSchema,
  hostSolveVerdictSchema,
  hostVerdictSchema,
  lobbySnapshotSchema,
  roomCommandRequestSchema,
  roomSnapshotSchema,
  roomEventPayloadSchemas,
} from '@jev/contracts';

describe('主持人命令契约', () => {
  it('六个主持人命令都在命令类型枚举里', () => {
    for (const type of ['request_host', 'approve_host', 'reject_host', 'revoke_host', 'resign_host', 'host_answer']) {
      expect(commandTypes).toContain(type);
    }
  });

  it('request_host / resign_host 不带参数', () => {
    expect(commandPayloadSchemas.request_host.parse({})).toEqual({});
    expect(commandPayloadSchemas.resign_host.parse({})).toEqual({});
  });

  it('approve_host / reject_host / revoke_host 必须带 userId', () => {
    expect(commandPayloadSchemas.approve_host.parse({ userId: 'u1' })).toEqual({ userId: 'u1' });
    expect(commandPayloadSchemas.approve_host.safeParse({}).success).toBe(false);
    expect(commandPayloadSchemas.reject_host.safeParse({ userId: 123 }).success).toBe(false);
    expect(commandPayloadSchemas.revoke_host.safeParse({}).success).toBe(false);
    expect(commandPayloadSchemas.revoke_host.parse({ userId: 'u1' })).toEqual({ userId: 'u1' });
  });

  it('host_answer 必须带 turnId 与合法判定（提问三值 + 还原三值）', () => {
    const uuid = '6e80ad00-10ea-4d61-9252-a285d1200865';
    expect(commandPayloadSchemas.host_answer.parse({ turnId: uuid, verdict: 'yes' })).toEqual({ turnId: uuid, verdict: 'yes' });
    expect(commandPayloadSchemas.host_answer.parse({ turnId: uuid, verdict: 'solved' })).toEqual({ turnId: uuid, verdict: 'solved' });
    // 人类主持没有「无法确定」这个选项
    expect(commandPayloadSchemas.host_answer.safeParse({ turnId: uuid, verdict: 'uncertain' }).success).toBe(false);
    expect(commandPayloadSchemas.host_answer.safeParse({ turnId: 'not-a-uuid', verdict: 'yes' }).success).toBe(false);
    expect(commandPayloadSchemas.host_answer.safeParse({ turnId: uuid }).success).toBe(false);
  });

  it('房间命令请求体按类型校验载荷', () => {
    const uuid = '6e80ad00-10ea-4d61-9252-a285d1200865';
    const request = roomCommandRequestSchema.parse({
      clientRequestId: uuid,
      type: 'host_answer',
      payload: { turnId: uuid, verdict: 'irrelevant' },
    });
    expect(request.payload).toEqual({ turnId: uuid, verdict: 'irrelevant' });
    expect(
      roomCommandRequestSchema.safeParse({ clientRequestId: uuid, type: 'host_answer', payload: { turnId: uuid, verdict: 'maybe' } }).success,
    ).toBe(false);
  });

  it('主持形态与判定取值都是稳定枚举', () => {
    expect(hostModeSchema.options).toEqual(['ai', 'user']);
    expect(hostAskVerdictSchema.options).toEqual(['yes', 'no', 'irrelevant']);
    expect(hostSolveVerdictSchema.options).toEqual(['solved', 'close', 'not_yet']);
    // 判定取值是两套枚举的并集：六个值都接受，其余拒绝
    for (const verdict of ['yes', 'no', 'irrelevant', 'solved', 'close', 'not_yet']) {
      expect(hostVerdictSchema.safeParse(verdict).success).toBe(true);
    }
    for (const verdict of ['uncertain', 'maybe', '', null]) {
      expect(hostVerdictSchema.safeParse(verdict).success).toBe(false);
    }
  });
});

describe('主持人事件契约', () => {
  it('四个主持人事件都带成员身份', () => {
    expect(roomEventPayloadSchemas['room.host_requested'].parse({ userId: 'u1', nickname: '甲' })).toEqual({ userId: 'u1', nickname: '甲' });
    expect(roomEventPayloadSchemas['room.host_approved'].parse({ userId: 'u1', nickname: '甲', previousUserId: null })).toEqual({
      userId: 'u1',
      nickname: '甲',
      previousUserId: null,
    });
    expect(roomEventPayloadSchemas['room.host_rejected'].parse({ userId: 'u1', nickname: '甲' })).toEqual({ userId: 'u1', nickname: '甲' });
    expect(roomEventPayloadSchemas['room.host_resigned'].parse({ userId: 'u1', nickname: '甲' })).toEqual({ userId: 'u1', nickname: '甲' });
  });

  it('turn.completed 可选携带判定来源', () => {
    const base = { turnId: 't1', result: 'yes', confidence: 1 };
    expect(roomEventPayloadSchemas['turn.completed'].parse(base)).toEqual(base);
    expect(roomEventPayloadSchemas['turn.completed'].parse({ ...base, source: 'host' }).source).toBe('host');
    expect(roomEventPayloadSchemas['turn.completed'].safeParse({ ...base, source: 'other' }).success).toBe(false);
  });
});

describe('快照契约', () => {
  it('房间快照必须带主持形态、当前主持人与待审申请', () => {
    const snapshot = {
      roomId: 'r1',
      roomStatus: 'playing',
      hostUserId: 'u1',
      controlVersion: 0,
      capacity: 8,
      hostMode: 'user',
      userHostId: 'u2',
      hostRequests: [{ userId: 'u3', nickname: '丙' }],
      round: null,
      members: [{ userId: 'u2', nickname: '乙', online: true, isHost: false, isUserHost: true, status: 'joined' }],
      turns: [],
      discussions: [],
      followupTargetRoomId: null,
      lastSeq: 0,
    };
    expect(roomSnapshotSchema.parse(snapshot).userHostId).toBe('u2');
    expect(roomSnapshotSchema.safeParse({ ...snapshot, hostMode: 'other' }).success).toBe(false);
    expect(roomSnapshotSchema.safeParse({ ...snapshot, hostRequests: undefined }).success).toBe(false);
  });

  it('会客厅快照与房间同构', () => {
    const snapshot = {
      lobbyId: '3f7c1f0e-2b6d-4a1f-9d3c-5f2b8a7c1e04',
      hostUserId: 'u1',
      capacity: 8,
      members: [{ userId: 'u2', nickname: '乙', online: true, isHost: false, isUserHost: true }],
      selectedPuzzle: null,
      hostMode: 'user',
      userHostId: 'u2',
      hostRequests: [],
    };
    expect(lobbySnapshotSchema.parse(snapshot).userHostId).toBe('u2');
    expect(lobbySnapshotSchema.safeParse({ ...snapshot, members: [{ userId: 'u2', nickname: '乙', online: true, isHost: false }] }).success).toBe(false);
  });
});
