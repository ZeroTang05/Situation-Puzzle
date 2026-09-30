/** 直接渲染展示组件并校验分页契约，不替换网络或浏览器。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { roomHistoryQuerySchema } from '@jev/contracts';
import { PuzzleSelection } from '../src/rooms/puzzle-selection.js';
import { MessageDelivery } from '../src/rooms/message-delivery.js';

describe('等待室选题入口', () => {
  it('未选时显示选题，确认后显示题名并保留重选入口', () => {
    const empty = renderToStaticMarkup(<PuzzleSelection title={null} href="/library?mode=select" />);
    expect(empty).toContain('选题');
    expect(empty).not.toContain('当前题目');
    const selected = renderToStaticMarkup(<PuzzleSelection title="井里最后一个人" href="/library?mode=select" />);
    expect(selected).toContain('<strong>井里最后一个人</strong>');
    expect(selected).toContain('重新选题');
  });
});

describe('消息发送标记', () => {
  it.each(['sending', 'sent'] as const)('正常状态 %s 不增加文字', (status) => {
    expect(renderToStaticMarkup(<MessageDelivery status={status} />)).toBe('');
  });
  it('失败原因和未知结果确认仍显示', () => {
    expect(renderToStaticMarkup(<MessageDelivery status="rejected" error="房间已关闭" />)).toContain('未发送：房间已关闭');
    expect(renderToStaticMarkup(<MessageDelivery status="confirming" />)).toContain('正在确认操作结果');
  });
});

describe('房间历史分页', () => {
  it('默认每页五间，接受查询字符串并限制单页数量', () => {
    expect(roomHistoryQuerySchema.parse({})).toEqual({ page: 1, limit: 5 });
    expect(roomHistoryQuerySchema.parse({ page: '2', limit: '5' })).toEqual({ page: 2, limit: 5 });
    for (const query of [{ page: '0' }, { page: '1.5' }, { limit: '21' }]) expect(roomHistoryQuerySchema.safeParse(query).success).toBe(false);
  });
});
