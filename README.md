# Jev 海龟汤 🐢

[English](./README.en.md) | 中文

> 一碗会自己聊的海龟汤 — 让 AI 主持人 Jev 陪你猜谜。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)
[![Built with Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Powered by Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![AI: Vercel AI Gateway](https://img.shields.io/badge/AI-Vercel%20AI%20Gateway-000?logo=vercel)](https://vercel.com/docs/ai-gateway)

**👉 在线畅玩：<https://puzzle.xiaobaozi.cn>**

---

## 这是什么

**海龟汤**是一种情境猜谜：主持人掌握一个故事的全部真相（"汤底"），只讲出离奇的开头（"汤面"）。玩家用「是 / 否 / 无关」的问题，慢慢逼近真相，最后用一段话还原整件事。

Jev 海龟汤把这个过程搬到了手机网页上：

- 你读一段汤面，问 Jev「她真的死在船上吗？」「凶手是熟人吗？」；
- Jev 只回答 **是 / 否 / 无关**，并在拿不准时坦白「无法确定」；
- 卡住了可以要 **三条提示**，逐条解锁；
- 觉得摸到真相了，就点 **还原真相**，把推理写下来，Jev 会判断 **破解成功 / 接近真相 / 还没猜对**；
- 实在不行，再点 **公布答案** 看汤底。

整个体验针对手机网页做了优化，打开链接即可玩，无需登录。

![Jev 海龟汤主界面](docs/screenshot-play.png)

---

## 亮点

| | |
|---|---|
| 🤖 **真人感的 AI 主持人** | Jev 不是脚本，每次判断都交给 LLM，给出 **是 / 否 / 无关** 与置信度；拿不准时会坦白说「无法确定」，不硬猜误导你。 |
| 📝 **三种收尾方式** | 「提示」逐条解锁，「公布答案」一次性看汤底，「还原真相」用一段话跟 Jev 互验。 |
| 📚 **内置精挑题库** | 出厂自带约 30 道情境谜题（经典改写 + 原创），每题配有提示，覆盖悬疑、推理与反转。 |
| 🌍 **中英双语** | 右上角一键切换 EN / ZH，内置题全部配有英文汤面、汤底和提示，语言选择会记住。 |
| 📊 **本地答题记录** | 已玩、已解出自动标记；记录只保存在当前浏览器。 |
| ✍️ **玩家投稿** | 在「出题」写下汤面、汤底和提示；Jev 审核通过后进入公开题库，未通过会提示原因。 |
| 🛡 **管理员后台** | 复核、下架或删除投稿，操作有日志可查。 |
| 🔗 **安心分享** | 分享链接只在地址栏放题目 ID，汤底永远不随链接外泄。 |
| 📱 **移动优先** | 单页网页适配手机触屏，可直接分享链接。 |
| 📕 **小红书小组件** | 原生轻量版复用同一份题库、文案和公开接口，记录保存在小组件本地。 |
| 🌗 **海洋夜色风** | 深色基底、圆角面板，长时间盯着屏幕也不刺眼。 |

---

## 题库一览

精选 / 改写 / 原创三类并存，每题都附三条提示。题源说明见 [`data/library-sources.md`](./data/library-sources.md)。

> 经典：《照片里的人》《一定要退回的信》《第二次掌声》《墙里长大的孩子》《讣告里多活的一年》……
>
> 原创：《画里的闪光》《别再叫我的名字》《报错的家门》《笑着说的求救》……

> 想先在本地玩一玩？不需要任何后端密钥：
>
> ```bash
> pnpm install
> cp .env.example .env.local        # NEXT_PUBLIC_API_URL 留空
> pnpm dev
> ```
>
> 然后打开 <http://localhost:3000>，用内置题库直接开玩。

## 小红书小组件

在项目根目录执行 `pnpm sync:xiaohongshu`，然后用小红书开发工具导入 [`platforms/xiaohongshu`](./platforms/xiaohongshu)。项目类型为小组件，基础库设为 3.152.1 或更高。

小组件是一页原生界面，包含游玩、题库、记录和出题。题库数据来自 `data/library.json`、`data/library.en.json`，界面文案来自 `lib/i18n.ts`；修改这些源文件后重新运行同步命令。小组件调用同一个 Cloudflare Worker 的公开接口，不请求小红书身份，也不保存用户账号。答题记录保存在小红书容器的本地存储中，与网页浏览器的本地记录分别保存。

发布前在小红书平台配置 `situation-puzzle-api.xiaobaozi.cn` 为合法请求域名，并确认 [`platforms/xiaohongshu/app.js`](./platforms/xiaohongshu/app.js) 中的 API 地址与已部署的 Worker 一致。

---

## 致谢

- 经典情境谜题来自社区公开资料（Minute Mysteries、Jed Hartman 情境谜题档案、Braingle、Puzzling Stack Exchange 等），题源与本项目改写说明见 [`data/library-sources.md`](./data/library-sources.md)。
- 判题服务由 [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) 提供，使用 `typesafe-ai/jev` evaluation model。

---

## 许可协议

本项目采用 **GNU General Public License v3.0** 开源 — 详见 [`LICENSE`](./LICENSE) 文件。
