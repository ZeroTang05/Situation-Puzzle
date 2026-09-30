/** 使用真实 React 渲染验证游玩与非游玩页面的布局边界。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomShell } from '../src/rooms/room-shell.js';

describe('房间屏幕布局', () => {
  it('游玩中启用固定屏幕布局，保留消息与底部操作区', () => {
    const markup = renderToStaticMarkup(<RoomShell playing><section className="chat">消息</section><footer className="composer">发送</footer></RoomShell>);
    expect(markup).toContain('class="shell room-shell room-playing"');
    expect(markup).toContain('<section class="chat">消息</section><footer class="composer">发送</footer>');
  });
  it('等待室和结算不启用固定高度，长内容可自然滚动', () => {
    const markup = renderToStaticMarkup(<RoomShell playing={false}><section>完整汤底与成员管理</section></RoomShell>);
    expect(markup).not.toContain('room-playing');
    expect(markup).toContain('完整汤底与成员管理');
    expect(markup).toContain('<main');
  });
});
