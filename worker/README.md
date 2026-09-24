# Cloudflare Worker 后端

## 它保存什么

- `soups`：玩家投稿、公开题目与审核状态。
- `moderation_logs`：发布、驳回、删除的操作记录。
- `users`、`user_identities`、`user_sessions`：无感用户身份、平台 OpenID 与登录态。
- `soup_progress`：平台用户的已玩、已解出记录与提问次数。

玩家投稿创建后立即保存为 `published` 并进入公开题库。管理后台可复核、下架或删除；公开题库接口只返回仍在公开的题目，不返回汤底。

## 首次部署

1. 在 Cloudflare 创建 D1 数据库：`pnpm exec wrangler d1 create Situation-Puzzle`。
2. 将命令输出的 `database_id` 写进 `wrangler.jsonc`。
3. 复制 `.dev.vars.example` 为 `.dev.vars`，填入 Vercel AI Gateway 密钥和管理员令牌。
4. 回到项目根目录执行 `pnpm install`，再执行 `pnpm --dir worker db:migrate:remote`。
5. 分别执行 `pnpm --dir worker exec wrangler secret put AI_GATEWAY_API_KEY`、`ADMIN_TOKEN`，并为要发布的平台设置 `BILIBILI_APP_ID`、`BILIBILI_APP_SECRET` 或 `XHS_APP_ID`、`XHS_APP_SECRET`，按提示输入值。
6. 将 `ALLOWED_ORIGIN` 修改为前端正式网址，并运行 `pnpm --dir worker deploy`。

## 本地开发

```powershell
# 在项目根目录执行
pnpm --dir worker db:migrate:local
pnpm --dir worker dev
```

初始题库不在迁移里：worker 每次启动读取项目根目录的 `data/library.json`，整体覆盖数据库中 `seed-` 开头的题目。改题库直接编辑该文件，dev 下保存即生效。

## 管理后台

前端服务端设置 `NEXT_PUBLIC_API_URL` 和 `ADMIN_TOKEN`，其中 `ADMIN_TOKEN` 必须与 Worker 的同名密钥一致。访问 `/admin` 时，浏览器会先弹出原生账号密码框：用户名填 `admin`，密码填 `ADMIN_TOKEN` 的值。验证通过后可查看待复核、公开、已驳回和已删除的投稿。审核请求由同源 Next.js 接口转发给 Worker，浏览器页面不会拿到管理员密钥。

后台必须通过 HTTPS 访问，避免浏览器原生认证凭据在传输中泄露。密码修改后，需要同步更新前端服务端和 Worker 的 `ADMIN_TOKEN`。

## 无感用户身份

网页首次访问时会在本地浏览器生成随机标识，答题记录也只保存在该浏览器的本地存储。刷新页面可继续查看记录；换浏览器、换设备或清除浏览器数据后，记录不会同步。网页访客不向后端创建用户或会话，也可以直接投稿；这类投稿的 `author_user_id` 为空。平台用户仍由后端识别，答题记录保存在 D1，可在同一平台身份下继续使用。

`platforms/bilibili` 和 `platforms/xiaohongshu` 是基础小程序壳。分别在 `app.js` 填写已发布网页的 HTTPS 地址，并在平台后台登记业务域名。壳调用 `bl.login()` 或 `xhs.login()` 得到一次性 `code`，经 WebView 地址传给网页；网页调用 Worker 的 `/api/auth/bilibili` 或 `/api/auth/xiaohongshu`。Worker 向对应平台换取 OpenID，建立或复用内部用户 ID，返回会话令牌。平台密钥与 `session_key` 留在服务端。刷新页面时，当前 WebView 会话继续使用原令牌；重新打开小程序会重新领取 `code`。

小程序的 OpenID 只在本小程序内唯一。两个平台的同一位玩家会得到两个内部用户 ID，目前不提供账号合并。B 站个人类型小程序暂不支持 WebView；需要具备相应主体资质并配置业务域名。平台真机登录需要各自的小程序账号和密钥联调。

`0002_soup_progress.sql` 增加答题记录表。有效提问标为「已玩」，真相还原被 Jev 判为「破解成功」且置信度至少 0.4 时标为「已解出」。记录页的总数只统计已公开题目，管理员删除或下架的题目不会计入当前统计。

`0003_publish_before_review.sql` 增加复核时间，并将原有待审核投稿转入公开待复核队列。新投稿立即公开；管理员通过复核后保留公开状态，下架或删除后从公开题库消失。上线时先运行数据库迁移，再部署 Worker 和前端。
