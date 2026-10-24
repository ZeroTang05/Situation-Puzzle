/** App 登录绑定验证：使用 Node 的真实 Web Storage 和 Web Crypto，需 --localstorage-file。 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { beginAppOAuth, consumeAppOAuthCallback } from '../src/auth/app-oauth.js';

const pendingKey = 'jev.app-oauth-pending';
afterEach(() => localStorage.removeItem(pendingKey));

describe.runIf(typeof localStorage !== 'undefined')('App 登录事务绑定', () => {
  it('没有本机登录时忽略外部链接，匹配登录只能消费一次', async () => {
    expect(consumeAppOAuthCallback('cn.xiaobaozi.sp:/oauth?code=attacker&state=x')).toBeNull();
    const state = await beginAppOAuth('/me');
    const result = consumeAppOAuthCallback(`cn.xiaobaozi.sp:/oauth?code=real-code&state=${state}&next=/attacker`);
    expect(result?.next).toBe('/me');
    expect(createHash('sha256').update(result!.verifier).digest('base64url')).toBe(state);
    expect(consumeAppOAuthCallback(`cn.xiaobaozi.sp:/oauth?code=real-code&state=${state}`)).toBeNull();
  });

  it('错误来源或其他登录事务的链接不会消耗本机登录', async () => {
    const state = await beginAppOAuth('/room/123');
    for (const url of [
      `https://example.com/oauth?state=${state}&code=a`,
      `cn.xiaobaozi.sp://external/oauth?state=${state}&code=a`,
      `cn.xiaobaozi.sp:/other?state=${state}&code=a`,
      'cn.xiaobaozi.sp:/oauth?state=wrong&code=a',
      'invalid-url',
    ]) expect(consumeAppOAuthCallback(url)).toBeNull();
    expect(consumeAppOAuthCallback(`cn.xiaobaozi.sp:/oauth?state=${state}&code=ok`)?.code).toBe('ok');
  });

  it('已过期或被下一次登录替换的事务无法回流', async () => {
    const oldState = await beginAppOAuth('/');
    const newState = await beginAppOAuth('/me');
    expect(consumeAppOAuthCallback(`cn.xiaobaozi.sp:/oauth?state=${oldState}&code=a`)).toBeNull();
    const pending = JSON.parse(localStorage.getItem(pendingKey)!);
    localStorage.setItem(pendingKey, JSON.stringify({ ...pending, expiresAt: Date.now() - 1 }));
    expect(consumeAppOAuthCallback(`cn.xiaobaozi.sp:/oauth?state=${newState}&code=a`)).toBeNull();
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });
});
