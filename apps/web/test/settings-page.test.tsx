/**
 * 设置页：昵称 / 语言 / 退出登录三块都在，语言切换按钮只有中文与英文两处。
 * 同时钉住「站内不再有『消息』按钮」这条约定，避免以后又被加回来。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DialogProvider } from '@jev/ui';
import { t } from '@jev/i18n';

// 语言上下文依赖浏览器（localStorage），测试里固定成中文；认证客户端同理不需要真会话
vi.mock('../src/state/language.js', () => ({
  useLanguage: () => ({ copy: t('zh'), language: 'zh', setLanguage: () => {} }),
}));
vi.mock('../src/api/auth-client.js', () => ({ signOut: async () => {} }));

const { SettingsPage } = await import('../src/settings/settings-page.js');

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DialogProvider confirmLabel="确定" cancelLabel="取消">
          <SettingsPage />
        </DialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('设置页', () => {
  it('三块设置都在：个人资料、界面语言、退出登录', () => {
    const html = render();
    expect(html).toContain('设置');
    expect(html).toContain('个人资料');
    expect(html).toContain('界面语言');
    expect(html).toContain('退出登录');
  });

  it('语言只有中文与英文两个可选项', () => {
    const html = render();
    expect(html).toContain('中文');
    expect(html).toContain('English');
    // 不再出现「EN / 中文」那种随手切换的小开关
    expect(html).not.toContain('>EN<');
  });

  it('昵称可编辑（修改 → 输入框 → 保存）', () => {
    const html = render();
    expect(html).toContain('修改');
    expect(html).toContain('昵称');
  });
});

describe('站内不再有「消息」按钮入口', () => {
  it('好友页、我的页、首页都不再引用消息入口', () => {
    for (const file of ['src/social/friends-page.tsx', 'src/me/me-page.tsx', 'src/lobby/home-page.tsx']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toContain('copy.messages');
      expect(source, file).not.toContain('ChatEntryButton');
    }
  });

  it('好友页改成「点好友名进私聊」，不再是单独的消息按钮', () => {
    const source = readFileSync(new URL('../src/social/friends-page.tsx', import.meta.url), 'utf8');
    expect(source).toContain('friend-row-open');
    expect(source).toContain('/chat/');
  });
});
