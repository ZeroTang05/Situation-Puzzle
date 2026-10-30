# 小红书海龟汤日更流水线

每天 22:00 自动产出当天的小红书素材：**今日汤面卡片 + 昨日汤底卡片 + 正文文案**，
题目按 `data/library.json` 的顺序依次推进（446 题，约 1.2 年）。

## 产物结构

```
data/xhs/
├── config.json          # 尺寸、配色、单图字数上限、背景图路径与提示词、默认话题标签
├── copy-template.txt    # 文案模板（占位符由脚本填充）
├── state.json           # 进度：nextIndex / history / lastPublished
├── assets/
│   ├── background-face.jpg    # 汤面背景（冷蓝走廊，AI 生成一次，已入库）
│   └── background-bottom.jpg  # 汤底背景（红光开门，AI 生成一次，已入库）
├── requests/<日期>.json # 当天的请求稿（只写文案三段，由 agent 写）
└── output/<日期>/
    ├── 01-汤面.png      # 成品卡片 1080×1440
    ├── 02-汤底.png
    ├── 文案.txt         # 可直接粘贴进小红书
    └── meta.json        # 事实留档（题号、题名、每张卡片字数、署名）
```

## 设计取舍

- **两张固定背景图**：汤面用冷蓝走廊、汤底用红光开门，AI 各生成一次后冻结入库；
  一眼能分辨"这是题目"还是"这是答案"，系列感统一。
- **卡片字数动态均衡**：卡片数 = ceil(正文长度 / `cardCharLimit`)，正文在卡片间均分
  （差 ≤1 字），因此每张大致 100～130 字，不会出现"一张图只有十几个字"的碎卡；
  切点优先落在句读上。标题、页脚、日序号、页码是固定装饰，不占正文预算。
- **AI 只画背景，不写字**：生图模型写中文必然错字。标题与汤面/汤底正文
  由 Playwright 真实排版压进图里（`scripts/xhs-poster.mjs`），文字零错字。
- **张数受控**：小红书单篇最多 18 张图。按新规则跑完全库：平均 3.7 张/天、
  最多 13 张，零超限；万一遇到极端长题，脚本会自动放宽单张字数上限并在
  `warnings` 里提示。
- **汤底保密**：`plan` 命令只输出今日汤面与**昨日**汤底，不输出今日答案——
  今日答案要等下一篇笔记才揭晓。
- **作者声明自动取源**：`data/sources.md` 的逐题来源表被解析成署名声明
  （改编题注明原作者与改写方式，原创题注明参考出处）。
- **进度只在成功后推进**：渲染任一步失败都不写 `state.json`；
  同一天重跑会复用同一个题号（幂等），不会跳题。
- **图序由脚本算，不许手写**：文案里"汤底在图几"取决于今日汤面占几张卡
  （全库 446 天里有 70 天汤面占 2～5 张），而写文案的 agent 是在渲染**之前**动手的，
  根本不知道真实张数。所以图序一律由脚本在渲染后按 `pages` 的真实页数计算，
  agent 要引用就写占位符 `{{prevImageStart}}`（渲染后替换成"图二"、"图二、图三"或"图二到图四"）。

## 命令

```bash
node scripts/xhs-daily.mjs plan [--date YYYY-MM-DD]   # 打印当天素材事实 + 请求稿格式
node scripts/xhs-daily.mjs run --input <请求.json>     # 分卡渲染 + 出文案 + 推进进度
node scripts/xhs-daily.mjs background --kind face|bottom [--force]   # 生成/刷新背景图（一般不动）
node scripts/xhs-daily.mjs status                      # 看到第几天、还剩几题
node scripts/xhs-daily.mjs reset --index N             # 手动回到第 N 题（1 起）
```

## 请求稿格式

```json
{
  "date": "2026-10-20",
  "copy": {
    "hook": "开场白，1-2 句，轻松口语",
    "guide": "结尾引导评论区的 1-2 句",
    "hashtags": ["#海龟汤", "#悬疑推理"]
  }
}
```

## 排期

`cron_create` 建的任务：每天 22:00（Asia/Shanghai），独立会话执行上面的流程，
完成后把卡片与文案交付到会话里。任务在 MCode 运行时注册，删任务用 `cron_delete`。

任务本身只写一行"去读 `docs/daily-post-runbook.md` 并按步骤执行"，细节全在 runbook 里。
**踩坑：任务的 `cron_name` 和 `prompt` 会被内容过滤**——含「小红书」「海龟汤」等词会返回
`HTTP 422: Content validation failed`；`agent_name` 也要用 `me`（填 `mavis` 同样 422）。
长提示词本身没问题，是那几个词触发过滤。

## 依赖

- `mcode-tools` CLI（Matrix 生图）只在重新生成背景图时用到；
- Playwright + Chromium：脚本优先用根工作区的 `playwright`，
  找不到时从 `apps/web` 的 `@playwright/test` 反查（pnpm 布局下同样可用），
  浏览器已装在 `%LOCALAPPDATA%\ms-playwright`（版本与 playwright 自带的不一致时脚本会自动探测）。

## 踩坑记录

- `radial-gradient(circle 8% 5% …)` 是非法语法（circle 只能给一个半径），
  一条写错会让整条 `background-image` 静默失效；
- `html` 设了背景色后，`body` 的 `background-image` 会被画布传播规则吞掉，
  背景层要放在独立 div 上；
- CSS 里的 `<div>` 必须写在 `<body>` 里，写进 `<style>` 块会被当 CSS 解析掉。
- 占位符替换要跑**两轮**：第一轮把 `{{guide}}` 整体代入后，它内部的
  `{{prevImageStart}}` 还没被解析，第二轮才补上。
- `renderCards` 返回的每页 `kind` 之前写错了（`p.kind` 应为 `p.section.kind`），
  一直是 `undefined`，导致按 `kind` 统计张数不可用——脚本要靠它算图序。
- 自家 API 的成功响应是 `{ data: {...}, requestId }`，**错误响应是
  `{ error: { code, message }, requestId }`**，两者形状不同，解析时别混。
  题库 `legacyId` 是英文 slug（如 `real-finish-line`），不是中文标题。
