# @jev/database

数据库 schema 与迁移。当前已应用的迁移：
- `drizzle/0000_consolidated.sql` —— 单文件全量初始化（合并自 0000~0008）
- `drizzle/0001_lobbies.sql` —— 会客厅 v3：`user_lobbies` / `lobby_members` / `lobby_invites`

新建数据库由 `pnpm run db:migrate` 一次性应用所有迁移。

## 约束

- **禁止 `ALTER TYPE ADD VALUE`**。理由：drizzle 的 `pg-core/dialect.js migrate()` 把一次 `migrate()` 调用的所有迁移包在同一个事务里执行，事务内的 `ALTER TYPE ADD VALUE` 不能在同一事务被引用（`55P04 unsafe use of new value`）。新增枚举值请改 `0000_consolidated.sql` 的 `CREATE TYPE`，或在新迁移文件里用 `CREATE TYPE` 新建枚举。
- **新增表 / 列 / 索引 / 新枚举**：放在新迁移文件（`NNNN_xxx.sql`），并在 `drizzle/meta/_journal.json` 追加条目。drizzle 会按序号顺序应用、跳过已 applied 的迁移。
- **schema 与 SQL 同步**：TypeScript schema 在 `src/schema/*.ts` 由 `pgTable` / `pgEnum` 定义；SQL 是它的等价 DDL 落地。任何修改都必须两边同时改并核对列名/类型/默认值/索引/外键完全一致。
- **重建数据库**：`docker compose down -v` 后再 `docker compose up -d`，API 启动时会自动跑 `pnpm run db:migrate`。已运行过的数据库不要再次执行（`__drizzle_migrations` 记录 hash）。

## 常用脚本

- `pnpm run db:migrate` — 应用迁移（由 `src/migrate.ts` 包装 drizzle migrator）
- `pnpm run db:seed` — 导入 `data/library.json` 内的题库种子（若配置）
