/**
 * 后台列表排序白名单的回归测试。
 *
 * 这层要钉死的是安全边界：ORDER BY 的列名不能由用户输入拼出来。
 * 任何「白名单外的列名也能排序」的实现都会重开 SQL 注入面，
 * 所以这里直接断言未登记的列名一律拿不到列。
 */
import { describe, expect, it } from 'vitest';
import { asc, desc, sql } from 'drizzle-orm';
import { orderBySort, parseSortOrder, resolveSort } from './admin-sort.js';
import { ORDER_SORT, PUZZLE_SORT, REPORT_SORT, ROOM_SORT, USER_SORT } from './admin-sort-columns.js';

const WHITELISTS = {
  puzzles: PUZZLE_SORT,
  users: USER_SORT,
  rooms: ROOM_SORT,
  reports: REPORT_SORT,
  orders: ORDER_SORT,
};

describe('后台排序白名单', () => {
  it('已登记的列名解析出列与方向', () => {
    const resolved = resolveSort('email', 'ASC', USER_SORT);
    expect(resolved).toBeTruthy();
    expect(resolved!.column).toBe(USER_SORT.email);
    expect(resolved!.order).toBe('ASC');
  });

  it('未登记的列名拿不到列（调用方回落默认顺序）', () => {
    expect(resolveSort('email; drop table users', 'ASC', USER_SORT)).toBeUndefined();
    expect(resolveSort('__proto__', 'ASC', USER_SORT)).toBeUndefined();
    expect(resolveSort('constructor', 'ASC', USER_SORT)).toBeUndefined();
    expect(resolveSort('toString', 'ASC', USER_SORT)).toBeUndefined();
  });

  it('没传列名时不排序', () => {
    expect(resolveSort(undefined, 'ASC', USER_SORT)).toBeUndefined();
    expect(resolveSort('', 'ASC', USER_SORT)).toBeUndefined();
  });

  it('方向只认 ASC / DESC，其余按 DESC', () => {
    expect(parseSortOrder('asc')).toBe('ASC');
    expect(parseSortOrder('ASC')).toBe('ASC');
    expect(parseSortOrder('desc')).toBe('DESC');
    expect(parseSortOrder('ASC; DROP TABLE users')).toBe('DESC');
    expect(parseSortOrder(undefined)).toBe('DESC');
  });

  it('ORDER BY 命中白名单时用请求的方向，未命中时用兜底顺序', () => {
    const fallback = desc(sql`created_at`);
    const tiebreaker = desc(sql`id`);
    const hit = orderBySort('email', 'ASC', USER_SORT, fallback, tiebreaker);
    expect(hit).toHaveLength(2);
    expect(hit[0]).not.toBe(fallback);

    const miss = orderBySort('unknown-column', 'ASC', USER_SORT, fallback, tiebreaker);
    expect(miss[0]).toBe(fallback);
    expect(miss[1]).toBe(tiebreaker);
  });

  it('每个列表的默认排序列都在白名单里（点表头才有反馈）', () => {
    for (const whitelist of Object.values(WHITELISTS)) {
      expect(whitelist.createdAt).toBeTruthy();
    }
  });

  it('白名单列名都是合法标识符（不可能拼出 SQL 片段）', () => {
    for (const [name, whitelist] of Object.entries(WHITELISTS)) {
      for (const key of Object.keys(whitelist)) {
        expect(key, `${name} 的列名必须是标识符`).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      }
    }
  });

  it('asc/desc 接受白名单里的 SQL 片段列', () => {
    const fragment = sql<number>`count(*)::int`;
    expect(() => asc(fragment)).not.toThrow();
    expect(() => desc(fragment)).not.toThrow();
  });
});
