/** 检查共用输入组件保留文本、限制和禁用状态，不替换浏览器或 API。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatInput } from '../src/game/chat-input.js';

describe('单人和多人共用输入框', () => {
  it.each([500, 1000, 1500])('单行高度保留 %i 字的输入限制和长文本', (maxLength) => {
    const text = '第一行\n第二行<&>';
    const markup = renderToStaticMarkup(<ChatInput maxLength={maxLength} value={text} readOnly aria-label="提问" />);
    expect(markup).toContain('rows="1"');
    expect(markup).toContain(`maxLength="${maxLength}"`);
    expect(markup).toContain('第一行\n第二行&lt;&amp;&gt;');
    expect(markup).toContain('aria-label="提问"');
  });
  it('连接尚未就绪时保留禁用状态', () => {
    expect(renderToStaticMarkup(<ChatInput disabled placeholder="提问" />)).toContain('disabled=""');
  });
});
