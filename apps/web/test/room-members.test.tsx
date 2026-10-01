/** 真实组件渲染：游玩中的房主管理使用同一成员列表。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemberList } from '../src/rooms/room-page.js';

const state = { hostUserId: 'host', members: [
  { userId: 'host', nickname: '房主甲', online: true, isHost: true },
  { userId: 'guest', nickname: '玩家乙', online: false, isHost: false },
] };
const onAction = () => { throw new Error('静态渲染不应执行成员操作'); };

describe('玩家管理', () => {
  it('房主看见成员与移除按钮，自己没有移除按钮', () => {
    const markup = renderToStaticMarkup(<MemberList state={state} me="host" isHost onKick={onAction} />);
    expect(markup).toContain('房主甲');
    expect(markup).toContain('玩家乙');
    expect(markup.match(/移除/g)).toHaveLength(1);
  });
  it('普通成员可查看名单，管理操作仅对房主显示', () => {
    const markup = renderToStaticMarkup(<MemberList state={state} me="guest" isHost={false} onKick={onAction} />);
    expect(markup).toContain('玩家乙');
    expect(markup).not.toContain('移除');
    expect(markup).toContain('class="member-name member-name-self">玩家乙</span>');
    expect(markup).not.toContain('玩家乙我');
  });
});
