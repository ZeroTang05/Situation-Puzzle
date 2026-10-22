/** 支付二维码提示：窄屏且只有二维码时，引导「用电脑扫码」。 */
import { describe, expect, it } from 'vitest';
import { narrowScanHint } from '../src/me/sponsor-hint.js';

describe('扫码提示选择', () => {
  it('窄屏且通道只能出二维码 → 提示用电脑扫码', () => {
    expect(narrowScanHint(true, false)).toBe(true);
  });

  it('宽屏（PC 网页）→ 保持「用手机扫码」', () => {
    expect(narrowScanHint(false, false)).toBe(false);
  });

  it('窄屏但有跳转链接（支付宝电脑网站支付）→ 照常可用，保持原提示', () => {
    expect(narrowScanHint(true, true)).toBe(false);
  });
});
