# Cloudflare Worker 后端

## 它保存什么

- `soups`：玩家投稿、公开题目与审核状态。
- `moderation_logs`：发布、驳回、删除的操作记录。
- `users`、`user_identities`、`user_sessions`：无感用户身份、平台 OpenID 与登录态。

玩家投稿会保存为 `pending`。管理后台发布后才会变成 `published`，公开题库接口只返回已发布的题目，并且绝不返回汤底。

## 首次部署

1. 在 Cloudflare 创建 D1 数据库：`pnpm exec wrangler d1 create jev-turtle-soup`。
2. 将命令输出的 `database_id` 写进 `wrangler.jsonc`。
3. 复制 `.dev.vars.example` 为 `.dev.vars`，填入 Vercel AI Gateway 密钥和管理员令牌。
4. 回到项目根目录执行 `pnpm install`，再执行 `pnpm --dir worker db:migrate:remote`。
5. 分别执行 `pnpm --dir worker exec wrangler secret put AI_GATEWAY_API_KEY`、`ADMIN_TOKEN`、`BILIBILI_APP_ID`、`BILIBILI_APP_SECRET`，按提示输入值。
6. 将 `ALLOWED_ORIGIN` 修改为前端正式网址，并运行 `pnpm --dir worker deploy`。

## 本地开发

```powershell
# 在项目根目录执行
pnpm --dir worker db:migrate:local
pnpm --dir worker dev
```

初始题库不在迁移里：worker 每次启动读取项目根目录的 `data/library.json`，整体覆盖数据库中 `seed-` 开头的题目。改题库直接编辑该文件，dev 下保存即生效。

## 管理后台

前端设置 `NEXT_PUBLIC_API_URL` 后访问 `/admin`。输入 `ADMIN_TOKEN` 即可查看待审核题目、发布、驳回或删除。

正式运营时，建议把 `/admin` 放在 Cloudflare Access 后面，令牌只作为第二层服务端校验。

## 无感用户身份

网页版本首次打开时会自动创建匿名身份，不显示注册、登录或授权页面。Worker 返回的会话令牌保存在设备本地，投稿会自动绑定 `author_user_id`。

接入 B 站小程序壳时，启动后调用 `bl.login()`，把返回的 `code` 发送给 `POST /api/auth/bilibili`。Worker 使用 `BILIBILI_APP_ID` 和 `BILIBILI_APP_SECRET` 向 B 站换取 OpenID，再建立或复用同一名用户；密钥与 session_key 都不会进入客户端。

小红书小程序同样应在启动时调用其官方登录能力，取得 OpenID 后接入同一张 `user_identities` 表。小红书具体登录 API 需要在你的小程序开放平台开通后按后台文档接入，因此当前 Worker 没有猜测或伪造该接口。
