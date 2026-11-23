/** 验证中英文品牌标题的标识引用和可访问名称，以及两端图标一致性。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandHeading } from '../src/brand-heading.js';
import { BRAND_NAME, BRAND_NAME_EN, t } from '@jev/i18n';

describe('统一品牌标识', () => {
  it.each([['zh', BRAND_NAME], ['en', BRAND_NAME_EN]] as const)('%s 界面使用对应语言的品牌名，图标不重复朗读', (language, brand) => {
    const title = t(language).brand;
    expect(title).toBe(brand);
    const html = renderToStaticMarkup(<BrandHeading>{title}</BrandHeading>);
    expect(html).toContain(`<span>${title}</span>`);
    expect(html).toContain('src="/icon.svg"');
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="28" height="28"');
  });
  it('玩家端和管理端使用完全相同的图标', () => {
    const web = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
    const admin = readFileSync(new URL('../../admin/public/icon.svg', import.meta.url), 'utf8');
    expect(admin).toBe(web);
  });
});
