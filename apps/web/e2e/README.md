# 游玩流程端到端测试

测试使用真实浏览器、API、数据库和 Jev，不替换接口。

准备步骤：

1. 使用独立的本地测试数据库，启动 API、jobs 和玩家端。
2. API 的 `PUBLIC_BASE_URL` 配置为 `http://localhost:5173`。
3. 测试数据库中应有已发布的中英文同版题目。本地导入可使用现有的 `pnpm db:seed`。
4. 首次使用时，在 `apps/web` 目录执行 `pnpm exec playwright install chromium` 安装测试浏览器。
5. 在仓库根目录执行 `pnpm --filter @jev/web test:e2e`。

默认访问 `http://localhost:5173`，可通过 `E2E_WEB_URL` 指定地址。测试会创建专用账号和房间，结束时关闭房间与浏览器；账号和游戏记录留在测试数据库中。

也可以用仓库根目录的编排器一键起环境（自建临时库 + 迁移 + 造中英同版题目 + 收信台 + API + jobs + 玩家端）：

```bash
pnpm e2e:local playwright   # 需要一个可连的 PostgreSQL（E2E_BASE_DATABASE_URL 可覆盖）
```

覆盖邀请复制与重置、登录后直接入房、游玩中的玩家管理和移除、两种模式的提示翻阅、真实模型置信度与刷新恢复，以及中英文题面与单人进度隔离。房间相关用例走 v3 的会客厅流程（会客厅 → 选题 → 开局），邀请链接为 `/room/invite/<hex>`。
