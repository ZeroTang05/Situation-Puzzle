/**
 * 大厅与公开房间的契约回归（18-HALL-PUBLIC-ROOMS）。
 *
 * 钉死四件事：
 *  1. set_visibility 命令的类型与载荷校验（错误载荷必须在服务端就被拒）；
 *  2. room.visibility_changed 事件的 payload 形状；
 *  3. 大厅列表与加入结果的响应形状（含满员标记）；
 *  4. 快照里的公开标记字段（房间 / 会客厅各一份）。
 */
import { describe, expect, it } from 'vitest';
import {
  commandPayloadSchemas,
  commandTypes,
  hallResponseSchema,
  hallRoomSchema,
  lobbySnapshotSchema,
  lobbyVisibilityRequestSchema,
  publicRoomJoinResponseSchema,
  roomCommandRequestSchema,
  roomEventPayloadSchemas,
  roomSnapshotSchema,
} from '@jev/contracts';

const uuid = '6e80ad00-10ea-4d61-9252-a285d1200865';

describe('公开 / 私人命令契约', () => {
  it('set_visibility 在命令类型枚举里', () => {
    expect(commandTypes).toContain('set_visibility');
  });

  it('载荷必须是一个布尔值', () => {
    expect(commandPayloadSchemas.set_visibility.parse({ isPublic: true })).toEqual({ isPublic: true });
    expect(commandPayloadSchemas.set_visibility.parse({ isPublic: false })).toEqual({ isPublic: false });
    for (const payload of [{}, { isPublic: 'true' }, { isPublic: 1 }, { isPublic: null }]) {
      expect(commandPayloadSchemas.set_visibility.safeParse(payload).success).toBe(false);
    }
  });

  it('房间命令请求体按类型校验载荷', () => {
    const request = roomCommandRequestSchema.parse({
      clientRequestId: uuid,
      type: 'set_visibility',
      payload: { isPublic: true },
    });
    expect(request.payload).toEqual({ isPublic: true });
    expect(
      roomCommandRequestSchema.safeParse({ clientRequestId: uuid, type: 'set_visibility', payload: { isPublic: 'yes' } }).success,
    ).toBe(false);
  });

  it('会客厅的开关请求体也是一个布尔值', () => {
    expect(lobbyVisibilityRequestSchema.parse({ isPublic: true })).toEqual({ isPublic: true });
    expect(lobbyVisibilityRequestSchema.safeParse({ isPublic: 'true' }).success).toBe(false);
    expect(lobbyVisibilityRequestSchema.safeParse({}).success).toBe(false);
  });

  it('公开状态变化事件只带一个布尔标记', () => {
    expect(roomEventPayloadSchemas['room.visibility_changed'].parse({ isPublic: true })).toEqual({ isPublic: true });
    expect(roomEventPayloadSchemas['room.visibility_changed'].safeParse({}).success).toBe(false);
    expect(roomEventPayloadSchemas['room.visibility_changed'].safeParse({ isPublic: 'yes' }).success).toBe(false);
  });
});

describe('大厅响应契约', () => {
  it('一条大厅记录带房主、人数与当前题目', () => {
    const room = {
      roomId: uuid,
      title: '终点线',
      language: 'zh',
      hostNickname: '甲',
      memberCount: 3,
      capacity: 8,
      full: false,
      status: 'playing',
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    expect(hallRoomSchema.parse(room)).toEqual(room);
  });

  it('没开局时题目与语言为 null', () => {
    const room = {
      roomId: uuid,
      title: null,
      language: null,
      hostNickname: '甲',
      memberCount: 1,
      capacity: 8,
      full: false,
      status: 'waiting',
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    expect(hallRoomSchema.parse(room).title).toBeNull();
  });

  it('房间 id 必须是 uuid，人数不能为负', () => {
    const room = {
      roomId: 'not-a-uuid',
      title: '终点线',
      language: 'zh',
      hostNickname: '甲',
      memberCount: 3,
      capacity: 8,
      full: false,
      status: 'playing',
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    expect(hallRoomSchema.safeParse(room).success).toBe(false);
    expect(hallRoomSchema.safeParse({ ...room, roomId: uuid, memberCount: -1 }).success).toBe(false);
    expect(hallResponseSchema.safeParse({ rooms: [] }).success).toBe(true);
  });

  it('加入结果区分「真加入」与「本来就在房里」', () => {
    expect(publicRoomJoinResponseSchema.parse({ roomId: uuid, joined: true }).joined).toBe(true);
    expect(publicRoomJoinResponseSchema.parse({ roomId: uuid, joined: false }).joined).toBe(false);
    expect(publicRoomJoinResponseSchema.safeParse({ roomId: uuid }).success).toBe(false);
  });
});

describe('快照里的公开标记', () => {
  it('房间快照带 isPublic', () => {
    const snapshot = {
      roomId: 'r1',
      roomStatus: 'playing',
      hostUserId: 'u1',
      controlVersion: 0,
      capacity: 8,
      isPublic: true,
      hostMode: 'ai',
      userHostId: null,
      hostRequests: [],
      round: null,
      members: [],
      turns: [],
      discussions: [],
      followupTargetRoomId: null,
      lastSeq: 0,
    };
    expect(roomSnapshotSchema.parse(snapshot).isPublic).toBe(true);
    expect(roomSnapshotSchema.safeParse({ ...snapshot, isPublic: undefined }).success).toBe(false);
  });

  it('会客厅快照带 isPublic', () => {
    const snapshot = {
      lobbyId: '3f7c1f0e-2b6d-4a1f-9d3c-5f2b8a7c1e04',
      hostUserId: 'u1',
      capacity: 8,
      isPublic: true,
      members: [],
      selectedPuzzle: null,
      hostMode: 'ai',
      userHostId: null,
      hostRequests: [],
    };
    expect(lobbySnapshotSchema.parse(snapshot).isPublic).toBe(true);
    expect(lobbySnapshotSchema.safeParse({ ...snapshot, isPublic: undefined }).success).toBe(false);
  });
});
