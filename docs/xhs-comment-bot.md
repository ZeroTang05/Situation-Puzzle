# 小红书评论区应答机器人

一个**本地常驻服务**：定时抓自己笔记下的新评论 → 判断是不是在提问 →
提问的调自家判题接口（是 / 否 / 无关 / 不确定）→ 按话术池随机挑一句回复。
不是提问的做轻互动（夸赞、猜答案也回一句），剧透的直接挡回去。

> 只产出回复，**不自动发笔记**。笔记正文仍然由日更流水线产出、用户自己粘贴发布。

## 文件

```
scripts/xhs-bot.mjs          # CLI 入口（login/discover/link/probe/once/run/status）
scripts/xhs-bot-driver.mjs   # Playwright 驱动：登录态、滚评论、抽评论、发回复、probe 诊断
scripts/xhs-bot-agent.mjs    # 分类（MiniMax）/ 判题（自家 API）/ 话术池
scripts/xhs-bot-store.mjs    # 状态存储（纯 JSON，原子写）
data/xhs/bot/config.json     # 配置
data/xhs/bot/browser-profile/  # 持久化浏览器用户目录（存登录态，已 gitignore）
data/xhs/bot/state.json      # 已处理评论 / 问答上下文 / 凭证缓存
data/xhs/bot/notes.json      # 笔记 → 题号 绑定
```

## 一次性准备（必须用户本人操作）

### 1. 扫码登录

```bash
node scripts/xhs-bot.mjs login
```

会弹出一个浏览器窗口，**用手机小红书 App 扫码**。登录态存在
`data/xhs/bot/browser-profile/`，之后长期复用，浏览器只需开一次。
Agent 不代持账号，扫码这一步只能本人做。

### 2. 绑定笔记

两种方式：

```bash
# 方式 A：填个人主页链接后自动发现（按笔记标题含《题名》自动匹配题号）
# 先编辑 data/xhs/bot/config.json，把 profileUrl 填成你的主页链接
node scripts/xhs-bot.mjs discover

# 方式 B：手动绑定单篇（链接 + 第几天）
node scripts/xhs-bot.mjs link <笔记链接> --day 1
```

`--day N` 的 N 是**连载第几天**（不是题库序号）——第 1 天 = `data/library.json` 第 1 题《终点线》。

### 3. 校准评论区选择器（强烈建议做一次）

小红书网页版改版频繁，选择器是「候选列表 + 结构兜底」，**未在真实页面上验证过**。
跑一次 probe 把结构 dump 出来，照着改 `scripts/xhs-bot-driver.mjs` 里的选择器：

```bash
node scripts/xhs-bot.mjs probe <笔记链接>
```

产物在 `data/xhs/bot/probe/`：`note.png`（截图）、`structure.json`（容器与 class 清单）、
`comment-area.html`（评论区 HTML 片段）。

## 日常运行

```bash
node scripts/xhs-judge-check.mjs        # 判题链路自检（不开浏览器，验 API/题库/判题三步）
node scripts/xhs-bot.mjs once            # 跑一轮就退出
node scripts/xhs-bot.mjs run             # 常驻，轮询间隔见 config（默认 120s）
node scripts/xhs-bot.mjs once --dry-run  # 只看会回什么，不真发、不标记已处理
node scripts/xhs-bot.mjs status           # 绑定情况、今日已回复数、话术池规模
```

常驻建议用 Windows 后台进程拉起（不需要每次手动开浏览器，登录态已存盘）。

## 判题链路

调自家 API（`config.json` 的 `apiBase`，默认 `http://localhost:8080/api/v1`）：

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 题目 UUID | `GET /puzzles?language=zh&cursor=` | 分页拉全量，按 `legacyId` 建索引（446 条） |
| 匿名凭证 | `POST /solo/sessions` | `{puzzleId, language}` → 24 小时有效，store 缓存 20 小时 |
| 判题 | `POST /solo/judge` | `{token, question, recentQas}` → `yes` / `no` / `irrelevant` / `uncertain` |

- `recentQas` 取该笔记最近 10 轮问答（**旧在前**），供判题做「他/她/那个」消解。
- 成功响应形状是 `{ data: {...}, requestId }`，**错误响应是 `{ error: {...} }`**，别混。
- `legacyId` 是英文 slug（如 `real-finish-line`），不是中文标题。

## 风控

小红书对自动化回复的识别比较敏感，脚本内置以下约束（`config.json` 可调）：

| 项 | 默认 | 理由 |
| --- | --- | --- |
| `replyDelaySec` | 25～70 秒随机 | 固定间隔会被判机器行为 |
| `maxRepliesPerDay` | 40 | 单日违规 3 次冻结评论权限 72 小时 |
| `maxRepliesPerNote` | 15 | 爆款笔记评论多时不能一口气全回 |
| `replyOnUncertain` | false | 判题拿不准的留给人，不硬回 |
| 话术池 | 每类 ≥6 条随机 + 随机尾巴 | **连续 3 条相同话术会被判机器行为** |

回复内容里不出现外链、联系方式、账号名。

## 分类器

用 MiniMax（Anthropic 兼容 messages 接口，`baseUrl` 见 config），把**汤底一起喂进去**，
这样才能识别剧透。四类：`question` / `chitchat` / `spoiler` / `ignore`
（`ignore` = 广告、加微信之类的，不回）。

- `max_tokens` 必须给 4096：模型先出 thinking 块，额度小会把正文截空。
- 阈值与判定语义以服务端为准，客户端不自己判「像不像提问」。

## 状态与幂等

- `processed` 记 `笔记ID:评论ID`，同一条评论只回一次。
- **发成功才标记已处理**：发失败（抛错）评论仍是未处理，下轮会重试。
- 明确不回的（`ignore`、`uncertain`）当场标记，永不再碰。
- `--dry-run` **不**标记已处理，所以试跑完正式跑还能再处理一遍。
