/** 验证原链接完整回跳、第三方登录目标和找回密码链路中的来源保留。 */
import { describe, expect, it } from 'vitest';
import { authStepHref, loginDestination, loginHref } from '../src/auth/login-navigation.js';

const origin = 'https://play.example.com';

describe('登录来源链接', () => {
  it.each(['/rooms/room-1?lang=en#chat', '/lobbies/lobby-1?selectPuzzle=puzzle-1&lang=zh', '/creations/new?lang=en', '/admin/users?page=2#row'])('登录后返回完整链接 %s', (path) => {
    const source = new URL(path, origin);
    const login = new URL(loginHref(source), origin);
    expect(login.pathname).toBe('/login');
    expect(login.searchParams.get('next')).toBe(path);
    expect(loginDestination(login.searchParams.get('next'), origin)).toBe(source.href);
  });
  it('未指定来源时返回首页，接受本站绝对地址', () => {
    expect(loginDestination(null, origin)).toBe(`${origin}/`);
    expect(loginDestination(`${origin}/me?lang=en`, origin)).toBe(`${origin}/me?lang=en`);
  });
  it('来源参数中的中文和特殊字符不会被再次拆分', () => {
    const source = new URL('/creations/new?title=终点线&source=a%26b#编辑', origin);
    const login = new URL(loginHref(source), origin);
    expect(loginDestination(login.searchParams.get('next'), origin)).toBe(source.href);
  });
  it('找回和重置密码后仍返回同一来源，并保留重置成功标记', () => {
    const path = '/rooms/room-1?lang=en#chat';
    const forgot = new URL(authStepHref('/forgot-password', path), origin);
    const reset = new URL(authStepHref('/reset-password?token=token-1', forgot.searchParams.get('next')), origin);
    const login = new URL(authStepHref('/login?reset=1', reset.searchParams.get('next')), origin);
    expect(reset.searchParams.get('token')).toBe('token-1');
    expect(login.searchParams.get('reset')).toBe('1');
    expect(loginDestination(login.searchParams.get('next'), origin)).toBe(`${origin}${path}`);
  });
  it('拒绝跳到站外地址', () => {
    expect(() => loginDestination('https://external.example.com', origin)).toThrow('当前网站');
    expect(() => loginDestination('//external.example.com', origin)).toThrow('当前网站');
  });
});
