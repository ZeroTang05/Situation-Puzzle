/**
 * 备份归档：纯 Node 实现的数据库逻辑导出 / 导入（不依赖 pg_dump 等外部二进制）。
 *
 * 归档是 gzip 压缩的 JSON，装下 public schema 全部普通表的结构与数据。
 * 关键设计：
 *  - 导出统一在 SQL 侧 ::text 文本化：bytea（\x…）、jsonb、数组字面量、numeric、enum
 *    都变成文本，NULL 天然保留；
 *  - 还原用「文本 → 目标类型」的 cast 写回，类型串取自 format_type(atttypid, atttypmod)，
 *    还原时与目标库结构严格匹配，SQL 类型只取目标库元数据；
 *  - 还原在单个事务里完成：任一步失败整体回滚，当前数据保持不变。
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import type { PoolClient } from 'pg';
import { DomainError } from '@jev/domain';

/** 归档格式标识与版本：解析时两者都要对上，否则判定为非法归档。 */
const ARCHIVE_FORMAT = 'jev-db-backup';
const ARCHIVE_VERSION = 1;

/** 每批插入的行数：控制单条语句的参数体积。 */
const INSERT_BATCH_SIZE = 500;

export interface BackupColumn {
  name: string;
  /** pg_catalog.format_type(atttypid, atttypmod) 的输出：还原时的 cast 目标 */
  type: string;
}

export interface BackupTable {
  schema: string;
  name: string;
  columns: BackupColumn[];
  rowCount: number;
}

export interface BackupArchive {
  format: 'jev-db-backup';
  version: 1;
  /** 备份生成时间（ISO） */
  createdAt: string;
  database: string;
  serverVersion: string;
  tables: BackupTable[];
  /** 行数据：key = `${schema}.${name}` */
  rows: Record<string, Array<Record<string, string | null>>>;
}

/** 标识符加引号：表名 / 列名里的双引号要翻倍。 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** 表全名：`"public"."rooms"` */
function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * 导出整个 public schema。
 *
 * 只取普通表（relkind='r'），排除分区子表与视图 / 物化视图：
 * 分区子表的数据已经包含在父表里，视图不是业务数据。
 */
export async function dumpArchive(client: PoolClient): Promise<BackupArchive> {
  // 时间戳统一按 UTC 文本化：会话时区不同会写出不同的字面量。
  // 用完恢复原值——client 来自连接池，不能把时区设置留给后面的使用者。
  const previousZone = await scalarText(client, `SELECT current_setting('TimeZone') AS value`);
  await client.query(`SELECT set_config('TimeZone', 'UTC', false)`);
  try {
    const database = await scalarText(client, 'SELECT current_database() AS value');
    const serverVersion = await scalarText(client, `SELECT current_setting('server_version') AS value`);

    const tables: BackupTable[] = [];
    const rows: Record<string, Array<Record<string, string | null>>> = {};

    for (const table of await listPublicTables(client)) {
      const columns = await listColumns(client, table.schema, table.name);
      const key = `${table.schema}.${table.name}`;
      const list = columns.length ? await readRows(client, table.schema, table.name, columns) : [];
      rows[key] = list;
      tables.push({ schema: table.schema, name: table.name, columns, rowCount: list.length });
    }

    return {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      createdAt: new Date().toISOString(),
      database,
      serverVersion,
      tables,
      rows,
    };
  } finally {
    await client.query(`SELECT set_config('TimeZone', $1, false)`, [previousZone]).catch(() => undefined);
  }
}

/**
 * 还原归档到当前数据库（单事务）。
 *
 * 注意：还原期间会阻塞业务写入——它 TRUNCATE 掉 public schema 全部表，
 * 并在同一个事务里写回数据，期间的其它写事务要么等待、要么因锁超时失败。
 * 这里的锁序约定（房间 → 局 → 赞助账户 → 免费账户 → 任务）对全局还原不适用。
 */
export async function restoreArchive(
  client: PoolClient,
  archive: BackupArchive,
): Promise<{ tableCount: number; rowCount: number }> {
  let rowCount = 0;
  await client.query('BEGIN');
  try {
    const liveTables = await listPublicTables(client);
    if (liveTables.length) {
      // 元数据验证和写入持有相同的表锁，期间不允许并发 DDL 改变列类型。
      await client.query(`LOCK TABLE ${liveTables.map(t => qualified(t.schema, t.name)).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    }
    const trustedTables = await matchArchiveTables(client, archive.tables, liveTables);
    const order = await insertionOrder(client, trustedTables);
    await disableForeignKeyTriggers(client);
    await truncatePublicTables(client);
    for (const table of order) {
      rowCount += await insertTable(client, table, archive);
    }
    await resetSequences(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof DomainError) throw error;
    throw new DomainError('BACKUP_FAILED', `还原失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return { tableCount: archive.tables.length, rowCount };
}

/** 打包成 gzip：JSON → Buffer。 */
export function encodeArchive(archive: BackupArchive): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(archive), 'utf8'));
}

/** 解包 gzip 并校验格式与版本：任何不匹配都算非法归档。 */
export function decodeArchive(buffer: Buffer): BackupArchive {
  let text: string;
  try {
    text = gunzipSync(buffer).toString('utf8');
  } catch {
    throw new DomainError('BACKUP_INVALID_ARCHIVE', '备份文件解压失败');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError('BACKUP_INVALID_ARCHIVE', '备份文件不是合法 JSON');
  }
  if (!isArchive(parsed)) {
    throw new DomainError('BACKUP_INVALID_ARCHIVE', '备份文件格式或版本不匹配');
  }
  return parsed;
}

// ---------- 导出内部实现 ----------

async function scalarText(client: PoolClient, sql: string): Promise<string> {
  const result = await client.query<{ value: string }>(sql);
  return result.rows[0]?.value ?? '';
}

/** public schema 下的普通表（排除分区子表）。 */
async function listPublicTables(client: PoolClient): Promise<Array<{ schema: string; name: string }>> {
  const result = await client.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = 'public'
        AND NOT c.relispartition
      ORDER BY c.relname`,
  );
  return result.rows;
}

/**
 * 表的列：名称 + format_type 输出。
 * 生成列（GENERATED ALWAYS AS）由数据库自己算，不进归档也不参与还原。
 */
async function listColumns(client: PoolClient, schema: string, name: string): Promise<BackupColumn[]> {
  const result = await client.query<{ name: string; type: string }>(
    `SELECT a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = $1::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attgenerated = ''
      ORDER BY a.attnum`,
    [qualified(schema, name)],
  );
  return result.rows;
}

/** 读整表数据：所有列在 SQL 侧 ::text，NULL 原样保留。 */
async function readRows(
  client: PoolClient,
  schema: string,
  name: string,
  columns: BackupColumn[],
): Promise<Array<Record<string, string | null>>> {
  const projection = columns.map((column) => `${quoteIdent(column.name)}::text AS ${quoteIdent(column.name)}`).join(', ');
  const result = await client.query<Record<string, string | null>>(
    `SELECT ${projection} FROM ${qualified(schema, name)}`,
  );
  return result.rows;
}

// ---------- 还原内部实现 ----------

/** 将归档结构与当前普通表逐列匹配；写入只使用数据库返回的类型。 */
async function matchArchiveTables(
  client: PoolClient,
  archived: BackupTable[],
  live: Array<{ schema: string; name: string }>,
): Promise<BackupTable[]> {
  const remaining = new Set(live.map(t => t.name));
  const trusted: BackupTable[] = [];
  for (const table of archived) {
    if (table.schema !== 'public' || !remaining.delete(table.name)) {
      throw new DomainError('BACKUP_INVALID_ARCHIVE', '归档表与当前数据库不匹配');
    }
    const columns = await listColumns(client, 'public', table.name);
    const expected = new Map(columns.map(c => [c.name, c.type]));
    if (columns.length !== table.columns.length || table.columns.some(c => expected.get(c.name) !== c.type || !expected.delete(c.name))) {
      throw new DomainError('BACKUP_INVALID_ARCHIVE', `表 ${table.name} 的列或类型与当前数据库不匹配`);
    }
    trusted.push({ ...table, columns });
  }
  if (remaining.size) throw new DomainError('BACKUP_INVALID_ARCHIVE', '归档缺少当前数据库的表');
  return trusted;
}

/**
 * 关掉外键触发器：session_replication_role=replica 时外键不再即时校验。
 * 权限不足（非超级用户）会报 42501，这时退化为「按外键依赖顺序插入」也能保证约束成立。
 */
async function disableForeignKeyTriggers(client: PoolClient): Promise<void> {
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '42501') throw error;
  }
}

/** 清空 public schema 全部表：一条语句列出所有表，RESTART IDENTITY 顺带重置序列。 */
async function truncatePublicTables(client: PoolClient): Promise<void> {
  const tables = await listPublicTables(client);
  if (tables.length === 0) return;
  const list = tables.map((table) => qualified(table.schema, table.name)).join(', ');
  await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * 插入顺序：按外键依赖拓扑排序，被引用的表先插。
 * 有环时按发现顺序断开（环内表的先后由外键触发器是否被关掉兜底）。
 */
async function insertionOrder(client: PoolClient, tables: BackupTable[]): Promise<BackupTable[]> {
  const result = await client.query<{ child: string; parent: string }>(
    `SELECT src.relname AS child, tgt.relname AS parent
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
       JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src.relnamespace
       JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_catalog.pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
      WHERE con.contype = 'f'
        AND src_ns.nspname = 'public'
        AND tgt_ns.nspname = 'public'`,
  );

  const names = new Set(tables.map((table) => table.name));
  /** parent → 依赖它的子表 */
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const table of tables) indegree.set(table.name, 0);
  for (const edge of result.rows) {
    if (!names.has(edge.child) || !names.has(edge.parent)) continue;
    dependents.set(edge.parent, [...(dependents.get(edge.parent) ?? []), edge.child]);
    indegree.set(edge.child, (indegree.get(edge.child) ?? 0) + 1);
  }

  const queue = tables.filter((table) => indegree.get(table.name) === 0).map((table) => table.name);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    ordered.push(name);
    for (const child of dependents.get(name) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }
  // 剩下的表在环里：按发现顺序追加
  for (const table of tables) {
    if (!ordered.includes(table.name)) ordered.push(table.name);
  }

  const byName = new Map(tables.map((table) => [table.name, table]));
  return ordered.map((name) => byName.get(name)!).filter(Boolean);
}

/**
 * 写回一张表：JSON 批量灌入，列值按已验证的目标库类型转换。
 */
async function insertTable(client: PoolClient, table: BackupTable, archive: BackupArchive): Promise<number> {
  const rows = archive.rows[`${table.schema}.${table.name}`] ?? [];
  if (rows.length === 0 || table.columns.length === 0) return 0;

  // 恒等列（GENERATED ALWAYS AS IDENTITY）必须显式覆盖才能写归档里的值
  const identity = await client.query<{ has_identity: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM pg_catalog.pg_attribute
               WHERE attrelid = $1::regclass
                 AND attidentity = 'a'
                 AND attnum > 0
                 AND NOT attisdropped) AS has_identity`,
    [qualified(table.schema, table.name)],
  );
  const overriding = identity.rows[0]?.has_identity ? ' OVERRIDING SYSTEM VALUE' : '';

  const columnList = table.columns.map((column) => quoteIdent(column.name)).join(', ');
  const projection = table.columns.map((column) => `_r.${quoteIdent(column.name)}::${column.type}`).join(', ');
  const recordset = table.columns.map((column) => `${quoteIdent(column.name)} text`).join(', ');
  const statement =
    `INSERT INTO ${qualified(table.schema, table.name)} (${columnList})${overriding} ` +
    `SELECT ${projection} FROM jsonb_to_recordset($1::jsonb) AS _r(${recordset})`;

  for (const batch of chunk(rows, INSERT_BATCH_SIZE)) {
    const payload = batch.map((row) => {
      const item: Record<string, string | null> = {};
      for (const column of table.columns) item[column.name] = row[column.name] ?? null;
      return item;
    });
    await client.query(statement, [JSON.stringify(payload)]);
  }
  return rows.length;
}

/**
 * 重置由列拥有的序列：nextval 落到 max(列值)+1，表为空时从 1 开始。
 * 只处理数值列的序列（uuid 之类的列没有 max 可用）。
 */
async function resetSequences(client: PoolClient): Promise<void> {
  const result = await client.query<{ schema: string; seq: string; table: string; column: string }>(
    `SELECT n.nspname AS schema,
            s.relname AS seq,
            t.relname AS table,
            a.attname AS column
       FROM pg_catalog.pg_class s
       JOIN pg_catalog.pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
       JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
      WHERE s.relkind = 'S'
        AND t.relkind = 'r'
        AND n.nspname = 'public'
        AND ty.typcategory = 'N'`,
  );

  for (const row of result.rows) {
    await client.query(
      `SELECT pg_catalog.setval($1::regclass,
                (COALESCE((SELECT max(${quoteIdent(row.column)}) FROM ${qualified(row.schema, row.table)}), 0) + 1)::bigint,
                false)`,
      [qualified(row.schema, row.seq)],
    );
  }
}

// ---------- 通用小工具 ----------

function isArchive(value: unknown): value is BackupArchive {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BackupArchive>;
  return (
    candidate.format === ARCHIVE_FORMAT &&
    candidate.version === ARCHIVE_VERSION &&
    Array.isArray(candidate.tables) &&
    typeof candidate.rows === 'object' &&
    candidate.rows !== null
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
