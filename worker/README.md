# Cloudflare Worker 后端

## 它保存什么

- `soups`：玩家投稿、公开题目与审核状态。
- `moderation_logs`：发布、驳回、删除的操作记录。
- `users`、`user_identities`、`user_sessions`：无感用户身份、平台 OpenID 与登录态。
- `soup_progress`：平台用户的已玩、已解出记录与提问次数。

玩家提交后，Worker 先让 Jev 对整道题做「通过 / 不通过」二元审核，检查色情和政治内容。审核期间题目不进入公开题库。通过后保存为 `published` 并公开；未通过则保存为 `rejected`，向投稿人明确提示。Jev 请求失败时投稿不公开，用户可以重试。管理后台仍可复核、下架或删除；公开题库接口不返回汤底。

Jev 调用集中在 `../lib/jev.ts`：投稿审核、提问判断、还原真相共用模型连接和结果校验。请求或结果出错时最多额外重试 2 次；三次均失败就向调用处返回错误。正式 Worker 和网页本地接口也调用这个模块。

`GET /api/soups?lang=en` 返回 30 道内置题的英文版和英文投稿；`lang=zh` 返回中文版和中文投稿。详情、汤底、提问、真相还原及答题记录接口也接受 `lang`。内置题中英文共用 ID；玩家投稿保存提交语言，不会自动翻译。表结构（含 `language` 列）统一在 `migrations/0001_initial.sql`，首次部署执行 `pnpm --dir worker db:migrate:remote` 即可。

分享链接使用 `?soup=题目ID`。网页通过 `GET /api/soups/:id` 读取对应的公开题目；该接口不返回汤底或创建者令牌。

## 首次部署

1. 在 Cloudflare 创建 D1 数据库：`pnpm exec wrangler d1 create Situation-Puzzle`。
2. 将命令输出的 `database_id` 写进 `wrangler.jsonc`。
3. 复制 `.dev.vars.example` 为 `.dev.vars`，填入 Vercel AI Gateway 密钥和管理员令牌。
4. 回到项目根目录执行 `pnpm install`，再执行 `pnpm --dir worker db:migrate:remote`。
5. 分别执行 `pnpm --dir worker exec wrangler secret put AI_GATEWAY_API_KEY`、`ADMIN_TOKEN`，并为要发布的平台设置 `BILIBILI_APP_ID`、`BILIBILI_APP_SECRET` 或 `XHS_APP_ID`、`XHS_APP_SECRET`，按提示输入值。
6. 将 `ALLOWED_ORIGIN` 修改为前端正式网址（多个域名用逗号分隔，如 `https://puzzle.xiaobaozi.cn,https://www.bilibili.com`；Worker 环境变量只认纯文本，不能写数组），并运行 `pnpm --dir worker run deploy`。

## 本地开发

```powershell
# 在项目根目录执行
pnpm --dir worker db:migrate:local
pnpm --dir worker dev
```

初始题库不在迁移里：worker 每次启动读取项目根目录的 `data/library.json`，整体覆盖数据库中 `seed-` 开头的题目。改题库直接编辑该文件，dev 下保存即生效。

## 管理后台

前端服务端设置 `NEXT_PUBLIC_API_URL`、`ADMIN_TOKEN` 和 `AI_GATEWAY_API_KEY`，其中 `ADMIN_TOKEN` 必须与 Worker 的同名密钥一致；`AI_GATEWAY_API_KEY` 供本地题目的 Jev 判断使用。访问 `/admin` 时，浏览器会先弹出原生账号密码框：用户名填 `admin`，密码填 `ADMIN_TOKEN` 的值。验证通过后可查看待复核、公开、已驳回和已删除的投稿。审核请求由同源 Next.js 接口转发给 Worker，浏览器页面不会拿到管理员密钥。

后台必须通过 HTTPS 访问，避免浏览器原生认证凭据在传输中泄露。密码修改后，需要同步更新前端服务端和 Worker 的 `ADMIN_TOKEN`。

## 无感用户身份

网页首次访问时会在本地浏览器生成随机标识，答题记录也只保存在该浏览器的本地存储。刷新页面可继续查看记录；换浏览器、换设备或清除浏览器数据后，记录不会同步。网页访客不向后端创建用户或会话，也可以直接投稿；这类投稿的 `author_user_id` 为空。平台用户仍由后端识别，答题记录保存在 D1，可在同一平台身份下继续使用。

`platforms/bilibili` 是基础小程序壳。它调用 `bl.login()` 得到一次性 `code`，再经 WebView 地址传给网页。`platforms/xiaohongshu` 是原生小组件，页面由 XHSML、CSS 和 JS 实现，直接调用 Worker 接口。打开小组件时，`xhs.login()` 的一次性 `code` 直接交给 Worker 的 `/api/auth/xiaohongshu`，换取本项目的用户令牌。Worker 向小红书换取 OpenID，建立或复用内部用户 ID。平台密钥与 `session_key` 留在服务端。

小红书开发者工具导入 `platforms/xiaohongshu` 目录，项目类型选择小组件。`app.js` 中的 `apiBaseUrl` 指向已部署的 Worker；还需在小红书后台把该 HTTPS 地址登记为 request 合法域名。`project.config.json` 由开发者工具维护，其中的 AppID 必须与 Worker 的 `XHS_APP_ID` 对应。小组件不加载网页，管理员后台仍使用原有网页 `/admin`。

小程序的 OpenID 只在本小程序内唯一。两个平台的同一位玩家会得到两个内部用户 ID，目前不提供账号合并。B 站个人类型小程序暂不支持 WebView；需要具备相应主体资质并配置业务域名。平台真机登录需要各自的小程序账号和密钥联调。

`soup_progress` 表记录答题进度：有效提问标为「已玩」，真相还原被 Jev 判为「破解成功」（置信度达到 `JEV_CONFIDENCE_THRESHOLD`）时标为「已解出」。记录页的总数只统计已公开题目，管理员删除或下架的题目不会计入当前统计。

新投稿先由 Jev 审核，通过后才公开；管理员随后仍可复核或下架。「历史待审」列表用于逐篇处理迁移前的待审核投稿（该逻辑与全部表结构已并入 `0001_initial.sql`，线上数据库已应用）。
