/**
 * 赞助码的纯规则：格式、归一化、校验。
 *
 * 放在 domain 层是为了让 API 核销、后台发码、离线 CLI 三处共用同一套规则，
 * 避免「CLI 生成的码站内认不出」这类跨端不一致。
 */
import { randomBytes } from 'node:crypto';

/** 去掉了 I/O/0/1 等易混字符，人工转写不会认错。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'JEV';
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;

/** 码本体格式：JEV-XXXX-XXXX-XXXX（16 位基 32 熵，约 1.15e24 种组合）。 */
export const REDEEM_CODE_PATTERN = /^JEV-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;

/**
 * 生成兑换码：JEV-XXXX-XXXX-XXXX。
 * randomSource 只在测试里替换，生产用 crypto.randomBytes。
 */
export function generateRedeemCode(randomSource: (size: number) => Uint8Array = randomBytes): string {
  const bytes = randomSource(CODE_GROUPS * CODE_GROUP_LEN);
  let index = 0;
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    let out = '';
    for (let i = 0; i < CODE_GROUP_LEN; i += 1) {
      out += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length];
      index += 1;
    }
    groups.push(out);
  }
  return `${CODE_PREFIX}-${groups.join('-')}`;
}

/** 归一化检索键：去空白与连字符后转大写；用户粘贴带空格或小写也能命中。 */
export function normalizeRedeemCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** 码本体是否形如 JEV-XXXX-XXXX-XXXX（仅格式校验，不代表该码存在）。 */
export function isWellFormedRedeemCode(code: string): boolean {
  return REDEEM_CODE_PATTERN.test(code.trim());
}
