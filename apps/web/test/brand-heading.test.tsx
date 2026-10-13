/** 验证中英文品牌标题的标识引用和可访问名称，以及两端图标一致性。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandHeading } from '../src/brand-heading.js';

describe('统一品牌标识', () => {
  it.each(['Jev 海龟汤', 'Jev Turtle Soup'])('品牌标题保留 %s，图标不重复朗读', (title) => {
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
