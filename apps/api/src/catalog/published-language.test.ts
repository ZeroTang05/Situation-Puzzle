/** 编译真实 Drizzle 查询，验证语言版本的发布约束，不连接或替换数据库。 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { publishedLanguageJoin } from './published-language.js';

describe('多语言发布版本', () => {
  it('通过相同版号关联语言，独立保留发布状态检查', () => {
    const condition = publishedLanguageJoin();
    if (!condition) throw new Error('发布条件缺失');
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.sql).toContain('"puzzle_versions"."puzzle_id" = "puzzles"."id"');
    expect(query.sql).toContain('"puzzle_versions"."moderation_status"');
    expect(query.params).toEqual(['published']);
    expect(query.sql).toContain('"puzzle_versions"."version_no"');
    expect(query.sql).toContain('published.id = "puzzles"."current_published_version_id"');
    expect(query.sql).not.toContain('"puzzle_versions"."id" = "puzzles"."current_published_version_id"');
  });
});
