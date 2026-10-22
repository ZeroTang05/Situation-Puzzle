/**
 * 后台列表排序：把前端点表头传下来的列名解析成可排序列。
 *
 * 为什么必须是白名单：ORDER BY 里的标识符没法用占位符参数化，
 * 拼字符串等于开了一条 SQL 注入面。只有登记在白名单里的列名才允许排序，
 * 其余一律回落各列表原本的默认顺序（最新在前）。
 *
 * 白名单里的键 = 后台列表的列名（Datagrid 的 source），
 * 值 = drizzle 列或等价的 SQL 片段（派生列用 SQL 表达式）。
 */
import { asc, desc, type AnyColumn, type SQL, type SQLWrapper } from 'drizzle-orm';

export type SortColumn = AnyColumn | SQLWrapper;
/** 列名 → 可排序列。 */
export type SortWhitelist = Record<string, SortColumn>;

export interface ResolvedSort {
  column: SortColumn;
  order: 'ASC' | 'DESC';
}

/** 方向只认 ASC / DESC（大小写不敏感）；其余一律按 DESC（后台默认最新在前）。 */
export function parseSortOrder(order: string | undefined): 'ASC' | 'DESC' {
  return (order ?? '').trim().toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

/**
 * 解析排序：列名不在白名单里（或没传）时返回 undefined，由调用方回落默认顺序。
 * 纯函数，不碰数据库，便于单测。
 */
export function resolveSort(
  sort: string | undefined,
  order: string | undefined,
  whitelist: SortWhitelist,
): ResolvedSort | undefined {
  if (!sort) return undefined;
  // 必须用 hasOwnProperty：白名单是普通对象，`__proto__` / `constructor` / `toString`
  // 这些原型链上的键都能取到值，直接索引等于给了一条「任意值当列用」的口子。
  if (!Object.prototype.hasOwnProperty.call(whitelist, sort)) return undefined;
  const column = whitelist[sort];
  if (!column) return undefined;
  return { column, order: parseSortOrder(order) };
}

/**
 * 生成 ORDER BY 表达式列表。
 * 末位次序键保证同一列值相同时翻页结果稳定（否则 LIMIT/OFFSET 会漏行或重复行）。
 */
export function orderBySort(
  sort: string | undefined,
  order: string | undefined,
  whitelist: SortWhitelist,
  fallback: SQL,
  tiebreaker: SQL,
): SQL[] {
  const resolved = resolveSort(sort, order, whitelist);
  const primary = resolved
    ? resolved.order === 'ASC'
      ? asc(resolved.column)
      : desc(resolved.column)
    : fallback;
  return [primary, tiebreaker];
}
