# @jev/database

数据库 schema 与迁移。当前 schema 由 **单一迁移文件** `drizzle/0000_consolidated.sql` 定义,新建数据库时由 `pnpm run db:migrate` 一次性应用。

## 约束

- **不要新增迁移文件**。任何 schema 变更都直接修改 `drizzle/0000_consolidated.sql`。理由:drizzle 的 `pg-core/dialect.js migrate()` 把所有迁移包在同一个事务里执行,事务内 `ALTER TYPE ADD VALUE` 不能在同一事务被引用(`55P04 unsafe use of new value`),枚举值必须并入原始 `CREATE TYPE`。这意味着追加式迁移天然失败。
- **重建数据库**:`docker compose down -v` 后再 `docker compose up -d`,API 启动时会自动跑 `pnpm run db:migrate`。已运行过的数据库不要再次执行(本文件 hash 已在 `__drizzle_migrations` 记录)。
- **schema 与 SQL 同步**:TypeScript schema 在 `src/schema/*.ts` 由 `pgTable` / `pgEnum` 定义;SQL 是它的等价 DDL 落地。任何修改都必须两边同时改并核对列名/类型/默认值/索引/外键完全一致。
- **新增枚举值**:直接在 `0000_consolidated.sql` 的 `CREATE TYPE` 里追加,不要用 `ALTER TYPE ADD VALUE`。

## 常用脚本

- `pnpm run db:migrate` — 应用迁移(由 `src/migrate.ts` 包装 drizzle migrator)
- `pnpm run db:seed` — 导入 `data/library.json` 内的题库种子(若配置)