/** 直接测试生产状态规则；不替换网络、数据库或浏览器环境。 */
import { describe, expect, it } from 'vitest';
import type { RoomEvent } from '@jev/contracts';
import type { RoomState } from '../src/rooms/room-state.js';
import type { PendingCommand, RoomLocal } from '../src/rooms/room-local.js';
import { confirmCommand, receiveEvent, reconnectDelay, recoveryAction } from '../src/rooms/reliability.js';

const initial = (): RoomState => ({ roomId: 'room-a', roomStatus: 'playing', hostUserId: 'user-a', controlVersion: 2, capacity: 8, round: null, members: [], turns: [], discussions: [], lastSeq: 0, followupTargetRoomId: null });
const discussion = (seq: number): RoomEvent<'discussion.created'> => ({ schemaVersion: 1, eventId: `event-${seq}`, roomId: 'room-a', roundId: 'round-a', seq, type: 'discussion.created', occurredAt: '2026-09-29T00:00:00Z', payload: { clientRequestId: `request-${seq}`, userId: 'user-a', nickname: '玩家', text: `讨论${seq}` } });
const pending = (type = 'ask', retries = 0): PendingCommand => ({ input: { clientRequestId: 'request-1', type, roundId: 'round-a', payload: { text: '问题' }, expectedControlVersion: 2 }, status: 'confirming', retries });
const local = (item: PendingCommand): RoomLocal => ({ key: 'user-a:room-a', userId: 'user-a', drafts: { ask: '问题', solve: '还原草稿', discussion: '讨论草稿' }, pending: [item], tab: 'qa', mode: 'ask' });
const result = { clientRequestId: 'request-1', status: 'accepted' as const, controlVersion: 2, turnId: 'turn-1', acceptedSeq: 1 };

describe('连续事件恢复', () => {
  it('缺口补齐前保持原记录与游标，补齐后按顺序应用', () => {
    const buffer = new Map<number, RoomEvent>();
    const before = initial();
    expect(receiveEvent(before, discussion(3), buffer)).toBe(before);
    const first = receiveEvent(before, discussion(1), buffer);
    expect(first.lastSeq).toBe(1);
    expect(first.discussions.map((d) => d.seq)).toEqual([1]);
    const complete = receiveEvent(first, discussion(2), buffer);
    expect(complete.lastSeq).toBe(3);
    expect(complete.discussions.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(buffer.size).toBe(0);
  });
  it('重复补发不会产生第二条消息', () => {
    const buffer = new Map<number, RoomEvent>();
    const state = receiveEvent(initial(), discussion(1), buffer);
    expect(receiveEvent(state, discussion(1), buffer)).toBe(state);
    expect(state.discussions).toHaveLength(1);
    expect(state.discussions[0]?.clientRequestId).toBe('request-1');
  });
  it('新房间不会接收旧房间事件', () => {
    const state = initial();
    const buffer = new Map<number, RoomEvent>();
    expect(receiveEvent(state, { ...discussion(1), roomId: 'room-old' }, buffer)).toBe(state);
    expect(buffer.size).toBe(0);
  });
  it('问答按编号对应，重复完成事件不会重复新增问题', () => {
    const buffer = new Map<number, RoomEvent>();
    const accepted: RoomEvent<'turn.accepted'> = { ...discussion(1), type: 'turn.accepted', payload: { clientRequestId: 'request-1', turnId: 'turn-1', userId: 'user-a', nickname: '玩家', kind: 'ask', text: '问题' } };
    const completed: RoomEvent<'turn.completed'> = { ...discussion(2), type: 'turn.completed', payload: { turnId: 'turn-1', result: 'yes', confidence: 0.9 } };
    let state = receiveEvent(initial(), completed, buffer);
    state = receiveEvent(state, accepted, buffer);
    state = receiveEvent(state, completed, buffer);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ clientRequestId: 'request-1', status: 'succeeded', result: 'yes' });
    expect(state.lastSeq).toBe(2);
  });
  it('无需修改页面内容的事件也推进游标', () => {
    const event: RoomEvent<'room.invite_rotated'> = { ...discussion(1), type: 'room.invite_rotated', payload: {} };
    expect(receiveEvent(initial(), event, new Map()).lastSeq).toBe(1);
  });
  it('恢复的归档与续玩事件保留历史并显示新房入口', () => {
    const buffer = new Map<number, RoomEvent>();
    let state = receiveEvent(initial(), discussion(1), buffer);
    state = receiveEvent(state, { ...discussion(2), type: 'room.closed', payload: { reason: 'round_ended' } }, buffer);
    state = receiveEvent(state, { ...discussion(3), type: 'room.followup_created', payload: { targetRoomId: 'room-new', hostUserId: 'user-a', puzzleTitle: '新题' } }, buffer);
    expect(state).toMatchObject({ roomStatus: 'closed', followupTargetRoomId: 'room-new', lastSeq: 3 });
    expect(state.discussions).toHaveLength(1);
  });
});

describe('发送确认与草稿', () => {
  it('确认后清空已发送草稿，并保留其他模式草稿', () => {
    const item = pending();
    const original = local(item);
    const confirmed = confirmCommand(original, item, result);
    expect(confirmed.pending[0]).toMatchObject({ status: 'sent', result });
    expect(confirmed.drafts).toEqual({ ask: '', solve: '还原草稿', discussion: '讨论草稿' });
    expect(original.pending[0]?.status).toBe('confirming');
  });
  it('迟到确认不会清除用户新输入的草稿', () => {
    const item = pending();
    const current = local(item);
    current.drafts.ask = '下一个问题';
    expect(confirmCommand(current, item, result).drafts.ask).toBe('下一个问题');
  });
  it('重复确认只更新同编号卡片，其他请求保持原状态', () => {
    const item = pending();
    const current = local(item);
    current.pending.push({ ...pending(), input: { ...item.input, clientRequestId: 'request-2' } });
    const confirmed = confirmCommand(confirmCommand(current, item, result), item, result);
    expect(confirmed.pending.map((p) => p.status)).toEqual(['sent', 'confirming']);
  });
  it.each(['ask', 'solve', 'discussion'])('%s 的未知结果仅允许一次原编号重投', (type) => {
    const item = pending(type);
    const frozen = JSON.stringify(item.input);
    expect(recoveryAction(item, false)).toBe('resend');
    expect(recoveryAction({ ...item, retries: 1 }, false)).toBe('query_only');
    expect(JSON.stringify(item.input)).toBe(frozen);
  });
  it.each(['reveal_answer', 'kick', 'leave'])('%s 未知结果只查询，避免误重放控制操作', (type) => {
    expect(recoveryAction(pending(type), false)).toBe('query_only');
  });
  it('房间已结束且查询无记录时停止重投', () => {
    expect(recoveryAction(pending(), true)).toBe('reject');
  });
});

describe('重连间隔', () => {
  it('逐步退避并限制在十五秒以内', () => {
    expect([0, 1, 2, 3, 4, 5, 100].map((n) => reconnectDelay(n, 0))).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
  });
  it('随机抖动分散同一时间恢复的客户端', () => {
    expect(reconnectDelay(0, 0.5)).toBe(650);
    expect(reconnectDelay(5, 0.99)).toBe(15000);
  });
});
