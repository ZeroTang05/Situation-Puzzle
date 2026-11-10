/** 遍历公开题库游标：随机选题必须读取全部页面，已玩记录由客户端自行排除。 */
export async function readAllCatalogItems<T>(readPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = []; let cursor: string | null = null;
  do {
    const page = await readPage(cursor);
    items.push(...page.items); cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}
