/**
 * 备份归档的真实数据库验证：需 BACKUP_TEST_DATABASE_URL。
 *
 * 覆盖：建表（各种列类型 + 外键 + 序列）→ 导出 → 破坏数据 → 还原 →
 * 逐字段比对（bytea / jsonb / 时间戳 / 数组 / 中文）→ 外键仍在、序列 nextval 正确 →
 * 归档被篡改（类型串塞危险字符）时拒绝还原。
 * 用独立临时库跑，结束后整库删除，不碰其它库的数据。
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@jev/domain';
import { decodeArchive, dumpArchive, encodeArchive, restoreArchive, type BackupArchive } from './archive.js';

const databaseUrl = process.env.BACKUP_TEST_DATABASE_URL;

/** 固定 id：比对时按 id 取行，避免 uuid 随机生成带来的噪声 */
const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const PARENT2_ID = '22222222-2222-4222-8222-222222222222';
const PARENT3_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHILD2_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

/** 全部列按文本形态取：归档存的就是文本形态，比对文本最能反映往返是否无损 */
const PARENT_TEXT_COLUMNS = [
  'id::text',
  'name',
  'nickname',
  'amount::text',
  'big_amount::text',
  'price::text',
  'flag::text',
  'created_at::text',
  'born_at::text',
  'birthday::text',
  'payload::text',
  'mood::text',
  'blob::text',
  'tags::text',
].join(', ');

describe.runIf(!!databaseUrl)('备份归档（真实数据库）', () => {
  const dbName = `jev_backup_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    const base = new URL(databaseUrl!);
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    control = new Pool({ connectionString: adminUrl.toString() });
    await control.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await control.query(`CREATE DATABASE "${dbName}"`);

    const testUrl = new URL(base);
    testUrl.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });
    client = await pool.connect();
    await createFixtures();
  });

  afterAll(async () => {
    try {
      client?.release();
      await pool?.end();
    } finally {
      if (control) {
        try {
          await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } finally {
          await control.end();
        }
      }
    }
  });

  it('导出：结构、列类型与行数正确', async () => {
    const archive = await dumpArchive(client);
    expect(archive.format).toBe('jev-db-backup');
    expect(archive.version).toBe(1);
    expect(archive.database).toBe(dbName);
    expect(archive.serverVersion).toMatch(/^\d+/);
    expect(archive.tables.map((table) => table.name).sort()).toEqual(['backup_test_child', 'backup_test_parent']);

    const parent = archive.tables.find((table) => table.name === 'backup_test_parent')!;
    const types = Object.fromEntries(parent.columns.map((column) => [column.name, column.type]));
    expect(types.id).toBe('uuid');
    expect(types.name).toBe('text');
    expect(types.nickname).toBe('character varying(64)');
    expect(types.amount).toBe('integer');
    expect(types.big_amount).toBe('bigint');
    expect(types.price).toBe('numeric(10,2)');
    expect(types.flag).toBe('boolean');
    expect(types.created_at).toBe('timestamp with time zone');
    expect(types.born_at).toBe('timestamp without time zone');
    expect(types.birthday).toBe('date');
    expect(types.payload).toBe('jsonb');
    expect(types.mood).toBe('backup_test_mood');
    expect(types.blob).toBe('bytea');
    expect(types.tags).toBe('text[]');
    expect(parent.rowCount).toBe(3);
  });

  it('还原：行数与逐字段值一致（bytea / jsonb / 时间戳 / 数组 / 中文）', async () => {
    const before = await readParentText();
    const archive = await dumpArchive(client);
    const decoded = decodeArchive(encodeArchive(archive));

    // 破坏数据：清空后塞一行脏数据，还原必须把它彻底盖掉
    await client.query('DELETE FROM backup_test_child');
    await client.query('DELETE FROM backup_test_parent');
    await client.query(`INSERT INTO backup_test_parent (id, name) VALUES ('${PARENT3_ID}', '脏数据')`);

    const result = await restoreArchive(client, decoded);
    expect(result.tableCount).toBe(2);
    expect(result.rowCount).toBe(5);

    const after = await readParentText();
    expect(after).toEqual(before);

    // 类型化断言：不是只有文本一样，值本身也要对
    const [row] = (
      await client.query(
        `SELECT amount, big_amount::text AS big_amount, price::text AS price, flag,
                created_at, payload, mood::text AS mood, encode(blob, 'hex') AS blob_hex,
                tags, nickname FROM backup_test_parent WHERE id = $1`,
        [PARENT_ID],
      )
    ).rows;
    expect(row.amount).toBe(42);
    expect(row.big_amount).toBe('9007199254740993');
    expect(row.price).toBe('1234.56');
    expect(row.flag).toBe(true);
    expect(new Date(row.created_at).toISOString()).toBe('2024-03-05T07:08:09.123Z');
    expect(row.payload).toEqual({ a: 1, b: { c: [1, 2, 3] } });
    expect(row.mood).toBe('happy');
    expect(row.blob_hex).toBe('48656c6c6f');
    expect(row.tags).toEqual(['中文', 'b']);
    expect(row.nickname).toBe('nick-中文');

    // NULL 原样保留
    const [sparse] = (await client.query('SELECT nickname, payload, blob, tags FROM backup_test_parent WHERE id = $1', [PARENT2_ID])).rows;
    expect(sparse.nickname).toBeNull();
    expect(sparse.payload).toBeNull();
    expect(sparse.blob).toBeNull();
    expect(sparse.tags).toBeNull();
  });

  it('还原：外键关系与序列 nextval 正确', async () => {
    const [constraints] = (await client.query(
      `SELECT count(*)::int AS count FROM pg_constraint
        WHERE conname = 'backup_test_child_parent_id_fkey' AND contype = 'f'`,
    )).rows;
    expect(constraints.count).toBe(1);

    const [joined] = (await client.query(
      `SELECT count(*)::int AS count FROM backup_test_child c
         JOIN backup_test_parent p ON p.id = c.parent_id`,
    )).rows;
    expect(joined.count).toBe(2);

    // 外键仍然生效：插入孤儿行必须失败
    await expect(
      client.query(`INSERT INTO backup_test_child (parent_id) VALUES ('99999999-9999-4999-8999-999999999999')`),
    ).rejects.toThrow();

    // 序列：还原前 serial_no 最大 3，nextval 应该是 4
    const [maxed] = (await client.query('SELECT max(serial_no)::text AS max FROM backup_test_parent')).rows;
    expect(maxed.max).toBe('3');
    const [next] = (await client.query(`SELECT nextval('backup_test_parent_serial_no_seq')::text AS next`)).rows;
    expect(next.next).toBe('4');
  });

  it('归档被篡改：类型串塞危险字符时拒绝还原，数据保持不变', async () => {
    const before = await readParentText();
    const archive = await dumpArchive(client);
    const tampered: BackupArchive = {
      ...archive,
      tables: archive.tables.map((table) =>
        table.name === 'backup_test_parent'
          ? {
              ...table,
              columns: table.columns.map((column) =>
                column.name === 'name' ? { ...column, type: 'text); DROP TABLE backup_test_child; --' } : column,
              ),
            }
          : table,
      ),
    };

    await expect(restoreArchive(client, tampered)).rejects.toMatchObject({ code: 'BACKUP_INVALID_ARCHIVE' });
    expect(await readParentText()).toEqual(before);
  });

  it('解码：不是合法归档文件时报 BACKUP_INVALID_ARCHIVE', async () => {
    expect(() => decodeArchive(Buffer.from('not gzip'))).toThrow(DomainError);
    expect(() => decodeArchive(encodeArchive({ format: 'other', version: 1 } as unknown as BackupArchive))).toThrow(
      /格式或版本不匹配/,
    );
  });

  async function readParentText(): Promise<Array<Record<string, string | null>>> {
    const result = await client.query(`SELECT ${PARENT_TEXT_COLUMNS} FROM backup_test_parent ORDER BY id`);
    return result.rows as Array<Record<string, string | null>>;
  }

  async function createFixtures(): Promise<void> {
    await client.query(`CREATE TYPE backup_test_mood AS ENUM ('happy', 'sad', 'angry')`);
    await client.query(`
      CREATE TABLE backup_test_parent (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        nickname varchar(64),
        amount integer,
        big_amount bigint,
        price numeric(10,2),
        flag boolean,
        created_at timestamptz,
        born_at timestamp,
        birthday date,
        payload jsonb,
        mood backup_test_mood,
        blob bytea,
        tags text[],
        serial_no serial NOT NULL
      )`);
    await client.query(`
      CREATE TABLE backup_test_child (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_id uuid NOT NULL REFERENCES backup_test_parent(id),
        note text
      )`);

    await client.query(
      `INSERT INTO backup_test_parent
         (id, name, nickname, amount, big_amount, price, flag, created_at, born_at, birthday, payload, mood, blob, tags)
       VALUES
         ($1, '中文名字', 'nick-中文', 42, 9007199254740993, 1234.56, true,
          '2024-03-05 07:08:09.123456+00', '2021-07-08 09:10:11.123456', '2020-02-29',
          '{"a": 1, "b": {"c": [1, 2, 3]}}'::jsonb, 'happy', decode('48656c6c6f', 'hex'), ARRAY['中文', 'b']),
         ($2, '稀疏行', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
         ($3, '边界行', '', 0, 0, 0.00, false, '1999-12-31 23:59:59+00', '1999-12-31 23:59:59', '1999-12-31',
          '{"empty": {}}'::jsonb, 'sad', decode('', 'hex'), ARRAY[]::text[])`,
      [PARENT_ID, PARENT2_ID, PARENT3_ID],
    );
    await client.query(
      `INSERT INTO backup_test_child (id, parent_id, note) VALUES ($1, $2, '子行一'), ($3, $4, NULL)`,
      [CHILD_ID, PARENT_ID, CHILD2_ID, PARENT2_ID],
    );
  }
});
