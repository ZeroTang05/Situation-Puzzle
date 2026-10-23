/**
 * 认证错误文案：better-auth 回的是英文原文（如 "Invalid email or password"），
 * 界面必须按错误码翻译，不能把英文原文透给用户；中英文案键也要对齐。
 */
import { describe, expect, it } from 'vitest';
import { copy, displayAuthError } from '@jev/i18n';

describe('认证错误翻译', () => {
  it('已知错误码按语言翻译', () => {
    expect(displayAuthError('INVALID_EMAIL_OR_PASSWORD', 'zh', '兜底')).toBe('邮箱或密码不正确。');
    expect(displayAuthError('INVALID_EMAIL_OR_PASSWORD', 'en', 'fallback')).toBe('Wrong email or password.');
    expect(displayAuthError('USER_ALREADY_EXISTS', 'zh', '兜底')).toBe('该邮箱已注册，请直接登录。');
    expect(displayAuthError('OTP_EXPIRED', 'zh', '兜底')).toBe('验证码已过期，请重新获取。');
  });

  it('未登记或缺失的错误码回落到本地化兜底，绝不透传英文原文', () => {
    expect(displayAuthError('SOMETHING_NEW', 'zh', '登录失败，请稍后再试')).toBe('登录失败，请稍后再试');
    expect(displayAuthError(undefined, 'zh', '登录失败，请稍后再试')).toBe('登录失败，请稍后再试');
    expect(displayAuthError(null, 'en', 'Sign-in failed')).toBe('Sign-in failed');
  });
});

describe('中英文案', () => {
  it('两套文案的键完全对齐（漏翻会在这里暴露）', () => {
    expect(Object.keys(copy.en).sort()).toEqual(Object.keys(copy.zh).sort());
  });

  it('设置页需要的文案都有中英两版', () => {
    for (const key of ['settingsTitle', 'settingsProfile', 'settingsLanguage', 'settingsAccount', 'languageChinese', 'languageEnglish', 'logoutConfirm', 'nicknameUpdated'] as const) {
      expect(copy.zh[key], key).toBeTruthy();
      expect(copy.en[key], key).toBeTruthy();
    }
  });
});
