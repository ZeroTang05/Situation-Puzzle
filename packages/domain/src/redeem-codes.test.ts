/** 赞助码格式与归一化规则。 */
import { describe, expect, it } from 'vitest';
import {
  REDEEM_CODE_PATTERN,
  generateRedeemCode,
  isWellFormedRedeemCode,
  normalizeRedeemCode,
} from './redeem-codes.js';

describe('redeem codes', () => {
  it('生成的码符合 JEV-XXXX-XXXX-XXXX 格式', () => {
    const code = generateRedeemCode();
    expect(code).toMatch(REDEEM_CODE_PATTERN);
    expect(isWellFormedRedeemCode(code)).toBe(true);
  });

  it('生成时只取用不含易混字符的字母表', () => {
    // 固定随机源：全 0xFF → 落在字母表尾部
    const code = generateRedeemCode(() => new Uint8Array(16).fill(255));
    expect(code).toMatch(/^JEV-[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    expect(code).not.toMatch(/[IO01]/);
  });

  it('生成的码互不相同', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRedeemCode()));
    expect(codes.size).toBe(200);
  });

  it('归一化去空白与连字符并转大写', () => {
    expect(normalizeRedeemCode('  jev-abcd-efgh-ijkl ')).toBe('JEVABCDEFGHIJKL');
    expect(normalizeRedeemCode('JEV-ABCD-EFGH-IJKL')).toBe('JEVABCDEFGHIJKL');
    expect(normalizeRedeemCode('jev abc def gh i j k l')).toBe('JEVABCDEFGHIJKL');
  });

  it('不同格式写法的归一化结果一致（用户手输容错）', () => {
    const canonical = generateRedeemCode();
    const spaced = canonical.replace(/-/g, ' ');
    const lower = canonical.toLowerCase();
    expect(normalizeRedeemCode(spaced)).toBe(normalizeRedeemCode(canonical));
    expect(normalizeRedeemCode(lower)).toBe(normalizeRedeemCode(canonical));
  });

  it('拒绝含易混字符或格式错误的码体', () => {
    expect(isWellFormedRedeemCode('JEV-ABCD-EFGH-I0KL')).toBe(false);
    expect(isWellFormedRedeemCode('JEV-ABCD-EFGH-IOKL')).toBe(false);
    expect(isWellFormedRedeemCode('XXX-ABCD-EFGH-IJKL')).toBe(false);
    expect(isWellFormedRedeemCode('JEV-ABCD-EFGH')).toBe(false);
  });
});
