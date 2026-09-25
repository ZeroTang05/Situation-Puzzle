# Cloudflare Worker 后端

## 它保存什么

- `soups`：玩家投稿、公开题目与审核状态。
- `moderation_logs`：发布、驳回、删除的操作记录。

产品不做用户体系：访客答题记录保存在各自浏览器的本地存储（`lib/browser-progress.ts`），服务端不存任何个人身份数据。
小红书小组件也使用这些公开接口，答题记录保存在小红书容器本地；两个前端都无需登录。

玩家提交后，Worker 先让 Jev 对整道题做「通过 / 不通过」二元审核，检查色情和政治内容。审核期间题目不进入公开题库。通过后保存为 `published` 并公开；未通过则保存为 `rejected`，向投稿人明确提示。Jev 请求失败时投稿不公开，用户可以重试。管理后台仍可复核、下架或删除；公开题库接口不返回汤底。

Jev 调用集中在 `../lib/jev.ts`：投稿审核、提问判断、还原真相共用模型连接和结果校验。请求或结果出错时最多额外重试 2 次；三次均失败就向调用处返回错误。正式 Worker 和网页本地接口也调用这个模块。

`GET /api/soups?lang=en` 返回 30 道内置题的英文版和英文投稿；`lang=zh` 返回中文版和中文投稿。详情、汤底、提问、真相还原接口也接受 `lang`。内置题中英文共用 ID；玩家投稿保存提交语言，不会自动翻译。表结构统一在 `migrations/0001_initial.sql`，首次部署执行 `pnpm --dir worker db:migrate:remote` 即可。

分享链接使用 `?soup=题目ID`。网页通过 `GET /api/soups/:id` 读取对应的公开题目；该接口不返回汤底或创建者令牌。

## 首次部署

1. 在 Cloudflare 创建 D1 数据库：`pnpm exec wrangler d1 create Situation-Puzzle`。
2. 将命令输出的 `database_id` 写进 `wrangler.jsonc`。
3. 复制 `.dev.vars.example` 为 `.dev.vars`，填入 OpenCode Zen 密钥（opencode.ai 注册后获取）和管理员令牌。
4. 回到项目根目录执行 `pnpm install`，再执行 `pnpm --dir worker db:migrate:remote`。
5. 分别执行 `pnpm --dir worker exec wrangler secret put OPENCODE_API_KEY`、`ADMIN_TOKEN`，按提示输入值。
6. 将 `ALLOWED_ORIGIN` 修改为前端正式网址（多个域名用逗号分隔，如 `https://puzzle.xiaobaozi.cn,https://www.bilibili.com`），并运行 `pnpm --dir worker run deploy`。

## 本地开发

```powershell
# 在项目根目录执行
pnpm --dir worker db:migrate:local
pnpm --dir worker dev
```

初始题库和统计表都在迁移里：`0001_initial.sql` 末尾的种子块由 `pnpm sync:seed` 从 `data/library.json` 生成，新库跑迁移即自带 30 道内置题；`stats` 表按语言存「已发布投稿数」计数。worker 运行期对种子行零写入（没有运行时播种逻辑）。

## 更新已有题库

编辑中英文题库后，先生成同步文件：

```powershell
pnpm sync:seed
pnpm sync:xiaohongshu
```

`sync:seed` 同时更新新库初始化种子和 `refresh-seeds.sql`。生成文件不会连接或修改线上数据库。已有数据库不用重建；在项目根目录按目标环境执行其中一条：

```powershell
# 本地 D1
pnpm --dir worker exec wrangler d1 execute Situation-Puzzle --local --file=refresh-seeds.sql

# 线上 D1：通过在线查询更新题库；直接调用 Node，避免 Windows 批处理命令长度限制
$seedSql = Get-Content -Raw -Encoding utf8 worker/refresh-seeds.sql
node worker/node_modules/wrangler/bin/wrangler.js --cwd worker d1 execute Situation-Puzzle --remote "--command=$seedSql"
```

更新文件只处理 `creator_token='seed'` 的内置题：新增题目、更新保留题的汤面/汤底/提示、将移出题库的旧题标记为 `deleted`。旧题数据和审核记录保留；玩家投稿、投稿统计和同 ID 题目的管理员审核状态保持不变。脚本可重复执行。

线上更新使用 `--command` 的查询接口。`--file` 走批量导入流程，期间数据库可能暂时无法接收查询，不适合不停机更新。操作前用 `pnpm --dir worker exec wrangler d1 time-travel info Situation-Puzzle` 记录恢复点，并备份待替换的内置题。

还需重新部署 Worker（其中包含英文题库和内置题排序），并重建发布所使用的网页、小红书或 B 站 Toy 前端。仅再次执行初始化迁移不会更新已迁移数据库中的题目。

汤数量统计：`GET /api/stats` 每语言读 1 行计数加内置题常量返回总数（seeds / published / total），不为计数扫描 soups 表。计数在投稿通过、后台复核/下架/删除时增量维护。

## 管理后台

前端服务端设置 `NEXT_PUBLIC_API_URL`、`ADMIN_TOKEN` 和 `OPENCODE_API_KEY`，其中 `ADMIN_TOKEN` 必须与 Worker 的同名密钥一致；`OPENCODE_API_KEY` 供本地题目的 Jev 判断使用。访问 `/admin` 时，浏览器会先弹出原生账号密码框：用户名填 `admin`，密码填 `ADMIN_TOKEN` 的值。验证通过后可查看待复核、公开、已驳回和已删除的投稿。审核请求由同源 Next.js 接口转发给 Worker，浏览器页面不会拿到管理员密钥。

后台必须通过 HTTPS 访问，避免浏览器原生认证凭据在传输中泄露。密码修改后，需要同步更新前端服务端和 Worker 的 `ADMIN_TOKEN`。

## 答题记录

所有访客的答题记录都保存在浏览器本地存储（`lib/browser-progress.ts`）：有效提问标为「已玩」，真相还原被 Jev 判为「破解成功」（置信度达到 `JEV_CONFIDENCE_THRESHOLD`）时标为「已解出」。刷新页面可继续查看记录；换浏览器、换设备或清除浏览器数据后，记录不会同步。投稿不要求身份；新题审核通过后直接公开，后续由管理员统一管理。

新投稿先由 Jev 审核，通过后才公开；管理员随后仍可复核或下架。
