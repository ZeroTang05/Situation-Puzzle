# 贡献指南

感谢关注 Jev 海龟汤。提交贡献前请先读完这份指南。

## 开发环境

1. 安装 Node.js 22+、pnpm 10、Docker
2. `pnpm install`
3. `cp .env.example .env.local` 并填写：数据库地址、`AUTH_SECRET`/`SOLO_TOKEN_SECRET`
   （`openssl rand -hex 32` 生成）、SMTP 发信参数、`OPENCODE_API_KEY`
4. 本地数据库与建表：

   ```bash
   docker run -d --name jev-pg -e POSTGRES_USER=jev -e POSTGRES_PASSWORD=jev \
     -e POSTGRES_DB=jev -p 5432:5432 postgres:17
   pnpm db:migrate
   pnpm db:seed   # 仅本地开发：导入题库并标记为可玩
   ```

5. 启动：`pnpm dev:api`、`pnpm dev:jobs`、`pnpm dev:web`（管理端 `pnpm dev:admin`）

## 提交前检查

```bash
pnpm typecheck   # 全部工作区 TypeScript 检查
pnpm test        # 领域规则与 Jev 适配单测
pnpm smoke       # 可选：本地冒烟（需要 Docker，会起一次性 PostgreSQL）
```

多人房间相关的改动请在本地完成双端联调（`pnpm e2e:multiplayer`），涉及判题的改动
必须用真实 Jev 密钥验证，不要用假成功替代。

## 约定

- **分支**：从 `main` 拉功能分支，PR 回 `main`
- **提交信息**：Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` …）
- **数据库迁移**：只追加，不修改已执行的迁移文件；表结构统一在
  `packages/database/src/schema/`，迁移文件由 `drizzle-kit generate` 生成
- **单人隐私是产品红线**：单人模式不创建服务端会话、不落任何对话/进度表；
  涉及单人路径的改动请对照 `docs/rebuild/08-SOLO.md` 自查
- **汤底保密**：任何公开接口、事件 payload 都不得包含汤底与未解锁提示
- **密钥不入库**：所有密钥走环境变量；`.env*` 已在 .gitignore
- **依赖**：能用成熟库就不造轮子；新增依赖需说明用途

## 报告问题

使用 Issue 模板；多人同步类问题请注明浏览器、网络环境与大致时间点，
方便对照服务端事件日志。

## 许可

提交即表示同意代码以 [GPL-3.0](LICENSE) 发布。题目内容（`data/`）的权利要求
与代码分开，投稿题目需声明原创或授权来源。
