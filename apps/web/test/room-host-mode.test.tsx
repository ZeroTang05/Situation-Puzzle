/** 用户主持人形态：成员列表徽标与入口、房间事件应用（17-USER-HOST-MODE）。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostVerdictButtons, MemberList } from '../src/rooms/room-page.js';
import { applyEvent, type RoomState } from '../src/rooms/room-state.js';

const noop = () => { throw new Error('静态渲染不应执行成员操作'); };

const state = {
  hostUserId: 'host',
  hostRequests: [{ userId: 'guest', nickname: '玩家乙' }],
  members: [
    { userId: 'host', nickname: '房主甲', online: true, isHost: true, isUserHost: false },
    { userId: 'guest', nickname: '玩家乙', online: false, isHost: false, isUserHost: false },
  ],
};

describe('玩家列表的主持人入口', () => {
  it('普通成员看到申请入口', () => {
    const markup = renderToStaticMarkup(
      <MemberList state={{ ...state, hostRequests: [] }} me="guest" isHost={false} onKick={noop} onRequestHost={noop} onApproveHost={noop} onRejectHost={noop} />,
    );
    expect(markup).toContain('申请成为主持人');
    expect(markup).not.toContain('批准');
  });
  it('已提交申请时显示等待审核且不可重复提交', () => {
    const markup = renderToStaticMarkup(
      <MemberList state={state} me="guest" isHost={false} onKick={noop} onRequestHost={noop} onApproveHost={noop} onRejectHost={noop} />,
    );
    expect(markup).toContain('申请中，等待房主审核');
    expect(markup).not.toContain('批准');
  });
  it('房主的列表里对待审申请给出批准与拒绝', () => {
    const markup = renderToStaticMarkup(
      <MemberList state={state} me="host" isHost onKick={noop} onRequestHost={noop} onApproveHost={noop} onRejectHost={noop} />,
    );
    expect(markup).toContain('批准');
    expect(markup).toContain('拒绝');
  });
  it('当前用户主持人带徽标并提供退出入口', () => {
    const hosting = {
      ...state,
      hostRequests: [],
      members: [
        { userId: 'host', nickname: '房主甲', online: true, isHost: true, isUserHost: false },
        { userId: 'guest', nickname: '玩家乙', online: false, isHost: false, isUserHost: true },
      ],
    };
    const markup = renderToStaticMarkup(
      <MemberList state={hosting} me="guest" isHost={false} onKick={noop} onRequestHost={noop} onResignHost={noop} />,
    );
    expect(markup).toContain('主持人');
    expect(markup).toContain('退出主持人');
    expect(markup).not.toContain('申请成为主持人');
  });
  it('房主可以撤销他人的主持身份', () => {
    const hosting = {
      ...state,
      hostRequests: [],
      members: [
        { userId: 'host', nickname: '房主甲', online: true, isHost: true, isUserHost: false },
        { userId: 'guest', nickname: '玩家乙', online: false, isHost: false, isUserHost: true },
      ],
    };
    const markup = renderToStaticMarkup(
      <MemberList state={hosting} me="host" isHost onKick={noop} onRequestHost={noop} onRevokeHost={noop} onResignHost={noop} />,
    );
    expect(markup).toContain('撤销主持');
  });
});

function event(type: string, payload: Record<string, unknown>, seq = 1) {
  return {
    schemaVersion: 1,
    eventId: `e-${seq}`,
    roomId: 'room',
    roundId: 'round',
    seq,
    type,
    occurredAt: new Date().toISOString(),
    payload,
  } as never;
}

const baseState: RoomState = {
  roomId: 'room',
  roomStatus: 'playing',
  hostUserId: 'host',
  controlVersion: 0,
  capacity: 8,
  hostMode: 'ai',
  userHostId: null,
  hostRequests: [],
  round: null,
  members: [
    { userId: 'host', nickname: '房主甲', online: true, isHost: true, isUserHost: false },
    { userId: 'guest', nickname: '玩家乙', online: true, isHost: false, isUserHost: false },
  ],
  turns: [],
  discussions: [],
  lastSeq: 0,
  followupTargetRoomId: null,
};

describe('用户主持人的快捷判定', () => {
  it('提供「是 / 否 / 无关」三个按钮', () => {
    const markup = renderToStaticMarkup(<HostVerdictButtons onAnswer={noop} />);
    expect(markup).toContain('是');
    expect(markup).toContain('否');
    expect(markup).toContain('无关');
  });
  it('还原判定给「破解成功 / 接近真相 / 还没猜对」', () => {
    const markup = renderToStaticMarkup(<HostVerdictButtons onAnswer={noop} verdicts={['solved', 'close', 'not_yet']} />);
    expect(markup).toContain('破解成功');
    expect(markup).toContain('接近真相');
    expect(markup).toContain('还没猜对');
    expect(markup).not.toContain('无关');
  });
  it('禁用状态下不可点击', () => {
    const markup = renderToStaticMarkup(<HostVerdictButtons onAnswer={noop} disabled />);
    expect(markup.match(/disabled/g)).toHaveLength(3);
  });
});

describe('主持人事件', () => {
  it('申请事件进入待审列表', () => {
    const next = applyEvent(baseState, event('room.host_requested', { userId: 'guest', nickname: '玩家乙' }));
    expect(next.hostRequests).toEqual([{ userId: 'guest', nickname: '玩家乙' }]);
  });
  it('批准事件切换主持人并卸任原主持人', () => {
    const hosted = { ...baseState, hostMode: 'user' as const, userHostId: 'host', members: baseState.members.map((m) => ({ ...m, isUserHost: m.userId === 'host' })) };
    const next = applyEvent(hosted, event('room.host_approved', { userId: 'guest', nickname: '玩家乙', previousUserId: 'host' }));
    expect(next.hostMode).toBe('user');
    expect(next.userHostId).toBe('guest');
    expect(next.members.find((m) => m.userId === 'guest')?.isUserHost).toBe(true);
    expect(next.members.find((m) => m.userId === 'host')?.isUserHost).toBe(false);
  });
  it('退出事件回到 AI 主持', () => {
    const hosted = { ...baseState, hostMode: 'user' as const, userHostId: 'guest', members: baseState.members.map((m) => ({ ...m, isUserHost: m.userId === 'guest' })) };
    const next = applyEvent(hosted, event('room.host_resigned', { userId: 'guest', nickname: '玩家乙' }));
    expect(next.hostMode).toBe('ai');
    expect(next.userHostId).toBeNull();
    expect(next.members.find((m) => m.userId === 'guest')?.isUserHost).toBe(false);
  });
});
