/** 验证页码范围、移动端显示数量、可访问性和服务端分页查询契约。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { catalogListQuerySchema } from '@jev/contracts';
import { CatalogPagination, paginationItems } from '../src/catalog/pagination.js';

describe('题库页码', () => {
  it('小列表展示全部页码', () => {
    expect(paginationItems(1, 1)).toEqual([1]);
    expect(paginationItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('大列表展开当前页附近的位置，并保留首尾页', () => {
    expect(paginationItems(1, 12)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 12]);
    expect(paginationItems(6, 12)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 12]);
    expect(paginationItems(12, 12)).toEqual([1, 'ellipsis', 8, 9, 10, 11, 12]);
  });
  it('每个有效页都有当前位置，页码有序且最多七个显示位置', () => {
    for (let total = 1; total <= 30; total++) {
      for (let page = 1; page <= total; page++) {
        const items = paginationItems(page, total);
        const numbers = items.filter((item): item is number => typeof item === 'number');
        expect(items.length).toBeLessThanOrEqual(7);
        expect(numbers).toContain(page);
        expect(numbers[0]).toBe(1);
        expect(numbers.at(-1)).toBe(total);
        expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
      }
    }
  });
  it('显示总数、当前页标记和分页导航名称', () => {
    const html = renderToStaticMarkup(<CatalogPagination page={6} totalPages={12} total={575} busy={false} onPage={() => {}} />);
    expect(html).toContain('共 575 题 · 第 6 / 12 页');
    expect(html).toContain('aria-label="题库分页"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="第 12 页"');
  });
  it('单页禁用前后翻页，加载时禁用所有页码操作', () => {
    const single = renderToStaticMarkup(<CatalogPagination page={1} totalPages={1} total={3} busy={false} onPage={() => {}} />);
    expect(single.match(/disabled=""/g)).toHaveLength(3);
    const loading = renderToStaticMarkup(<CatalogPagination page={6} totalPages={12} total={575} busy onPage={() => {}} />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/disabled=""/g)).toHaveLength(7);
  });
});

describe('题库分页查询契约', () => {
  it('接受直接跳页并保留全部筛选条件', () => {
    expect(catalogListQuerySchema.parse({ page: '8', limit: '50', language: 'en', sort: 'popular', category: 'henkaku', difficulty: 'hard' }))
      .toEqual({ page: 8, limit: 50, language: 'en', sort: 'popular', category: 'henkaku', difficulty: 'hard' });
  });
  it('连续读取保留原游标查询，禁止页码与游标混用', () => {
    expect(catalogListQuerySchema.parse({ cursor: 'l:123:id' })).toEqual({ cursor: 'l:123:id', language: 'zh', sort: 'latest', limit: 20 });
    expect(catalogListQuerySchema.safeParse({ page: 1, cursor: 'l:123:id' }).success).toBe(false);
  });
  it('拒绝无效页码和超出接口上限的页面大小', () => {
    for (const page of [0, -1, 1.5, 'invalid', Infinity]) expect(catalogListQuerySchema.safeParse({ page }).success).toBe(false);
    expect(catalogListQuerySchema.safeParse({ page: 1, limit: 101 }).success).toBe(false);
  });
});
