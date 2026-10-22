/** 界面语言解析：只认 zh / en，其余不猜，交给上层按账号档案兜底。 */
import { describe, expect, it } from 'vitest';
import { languageFromHeaders, parseLanguage } from './language.js';

describe('界面语言解析', () => {
  it('识别 zh / en 及带地区后缀的形式', () => {
    expect(parseLanguage('zh')).toBe('zh');
    expect(parseLanguage('zh-CN')).toBe('zh');
    expect(parseLanguage('en')).toBe('en');
    expect(parseLanguage('en-US')).toBe('en');
    expect(parseLanguage(' EN ')).toBe('en');
  });

  it('空值与非法值不猜语言', () => {
    expect(parseLanguage(null)).toBeNull();
    expect(parseLanguage(undefined)).toBeNull();
    expect(parseLanguage('')).toBeNull();
    expect(parseLanguage('jp')).toBeNull();
  });

  it('从请求头读实时语言（Request 头与 Express 头对象都支持）', () => {
    expect(languageFromHeaders(new Headers({ 'x-jev-language': 'en' }))).toBe('en');
    expect(languageFromHeaders(new Headers())).toBeNull();
    expect(languageFromHeaders({ 'x-jev-language': 'en' })).toBe('en');
    expect(languageFromHeaders({ 'x-jev-language': ['zh'] })).toBe('zh');
    expect(languageFromHeaders(undefined)).toBeNull();
  });
});
