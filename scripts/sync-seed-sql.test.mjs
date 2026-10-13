/** 用真实 SQLite 检查种子内容、D1 语句长度与重复更新。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('种子文件满足 D1 长度限制并能重复更新全部题目', () => {
  const library = JSON.parse(readFileSync(new URL('../data/library.json', import.meta.url), 'utf8'));
  const migration = readFileSync(new URL('../worker/migrations/0001_initial.sql', import.meta.url), 'utf8');
  const refresh = readFileSync(new URL('../worker/refresh-seeds.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    // 按生成器固定前缀检查写入段长度，SQL 语法和内容由真实 SQLite 执行验证。
    for (const file of [migration, refresh]) {
      const sections = file.split('INSERT INTO soups ');
      assert.equal(sections.length - 1, library.length);
      assert.ok(Buffer.byteLength(sections[0], 'utf8') < 100_000);
      for (const section of sections.slice(1)) assert.ok(Buffer.byteLength(`INSERT INTO soups ${section}`, 'utf8') < 100_000);
    }
    for (let pass = 0; pass < 2; pass++) {
      db.exec(refresh);
      const rows = db.prepare("SELECT id,title,story,answer,hints FROM soups WHERE creator_token='seed'").all();
      assert.equal(rows.length, library.length);
      const expected = new Map(library.map((item) => [item.id, item]));
      for (const row of rows) assert.deepEqual({ ...row, hints: JSON.parse(row.hints) }, expected.get(row.id));
    }
  } finally { db.close(); }
});
