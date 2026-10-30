/**
 * 微信小程序 code2session 响应解析测试：
 * 成功负载取 openid（unionid 可选）；微信错误码映射稳定错误码；
 * 缺 openid 属协议异常，直接失败不编造身份。
 */
import { describe, expect, it } from 'vitest';
import { parseCode2Session } from './wechat-mini.js';
import { APIError } from 'better-auth/api';

/** 断言抛出且错误体里带指定稳定错误码 */
function expectApiError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    const body = (error as APIError).body as Record<string, unknown>;
    expect(body.code).toBe(code);
    return;
  }
  throw new Error('expected parseCode2Session to throw');
}

describe('parseCode2Session', () => {
  it('成功负载取 openid，unionid/session_key 可选透传', () => {
    expect(parseCode2Session({ openid: 'oABC', session_key: 'sk', unionid: 'uni' })).toEqual({
      openid: 'oABC',
      unionid: 'uni',
      session_key: 'sk',
    });
    expect(parseCode2Session({ openid: 'oABC', session_key: 'sk' })).toEqual({ openid: 'oABC', session_key: 'sk' });
    // 成功响应可能不带 errcode 字段；errcode:0 也按成功处理
    expect(parseCode2Session({ openid: 'oABC', errcode: 0, errmsg: 'ok' })).toEqual({ openid: 'oABC' });
  });

  it('code 无效/已使用映射 WECHAT_LOGIN_FAILED', () => {
    expectApiError(() => parseCode2Session({ errcode: 40029, errmsg: 'invalid js_code' }), 'WECHAT_LOGIN_FAILED');
    expectApiError(() => parseCode2Session({ errcode: 40126, errmsg: 'code been used' }), 'WECHAT_LOGIN_FAILED');
  });

  it('微信限流/繁忙映射 WECHAT_LOGIN_BUSY', () => {
    expectApiError(() => parseCode2Session({ errcode: 45011, errmsg: 'api minute-quota reach limit' }), 'WECHAT_LOGIN_BUSY');
    expectApiError(() => parseCode2Session({ errcode: -1, errmsg: 'system busy' }), 'WECHAT_LOGIN_BUSY');
  });

  it('成功形态但缺 openid 按协议异常失败', () => {
    expectApiError(() => parseCode2Session({ session_key: 'sk' }), 'WECHAT_LOGIN_FAILED');
    expectApiError(() => parseCode2Session(null), 'WECHAT_LOGIN_FAILED');
  });
});
