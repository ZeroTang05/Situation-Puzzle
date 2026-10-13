# Jev 小红书小工具

把原小组件迁移为小红书离线 H5 小工具，保留深蓝界面、中英文题库、提问、三条提示、还原真相、公布汤底与本地答题记录。源码在本目录；原小组件保留在相邻的 `海龟汤/` 目录。

## 构建与交付

在项目根目录执行：

```powershell
pnpm build:xhs-tool
```

需要本机现有 Node.js、Python，以及按上传页口令解压到 `.codex/minitool-zip-builder/` 的官方 Skill。构建脚本读取统一的 `data/library*.json`、`lib/i18n.ts` 和 `lib/prompts/*.ts`，生成静态文件，检查入口、资源、DOM 与禁用能力，调用官方审计脚本，随后打包。

| 输出 | 用途 |
| --- | --- |
| `minitool-dist/jev-xiaohongshu-minitool.zip` | 上传到创服平台的最终产物 |
| `minitool-dist/validation-summary.md` | 本次校验摘要 |
| `minitool-dist/app/` | 打包内容；ZIP 根目录直接包含 `index.html` |

包内只有 HTML、CSS 和经典 JavaScript 脚本，静态资源全部本地加载。业务脚本使用 ES2017（JavaScript 2017 语法），CSS 保留 Chrome 61 基线。题库列表按每页 20 条渲染。

## 判题、记录与分享

- 判题调用官方 `window.xhs.AI.createModel("deepseek-v4-flash")`，提问和还原继续使用项目现有提示词。还原接受等价表达与不影响真相的细节省略。
- 平台 AI 需要为小工具 appId 申请内测白名单。未开通时平台返回 `AI_NOT_ALLOWED`，页面会显示原因；没有模拟判题实现。
- 新容器禁止页面联网，因此不调用 Worker、Jev 或 MiniMax；原模型切换开关移除，题库随构建更新。
- 客户端 9.46+ 优先使用官方 Storage（本地缓存）API。低版本按官方约定使用实际浏览器存储，存储不可用时明确提示；平台 API 调用失败不会转用其他存储。
- 小组件和小工具使用独立缓存，新版不能自动读取旧小组件的答题记录。
- 玩家点击分享后生成汤面卡片，由官方 `postNote` 唤起笔记发布页，玩家决定是否发布。
- 汤底随离线包内置；界面在确认公布答案或还原成功后展示。

能力契约以[当前在线文档](https://miniapp-sandbox.xiaohongshu.com/minitool/doc)和[本次下载的 Skill](../../../.codex/minitool-zip-builder/SKILL.md)为准。

## 上传前验证

静态检查与普通浏览器预览不能替代容器验收。请把生成的同一份 ZIP 上传创服平台：

- [ ] 创服平台模拟器：完整验证切题、双语、题库搜索分页、提示、公布汤底、AI 提问与还原、进度保存、分享。
- [ ] Android 真机扫码：验证相同功能、长文本滚动、软键盘、安全区和页面重新打开。
- [ ] iOS 真机扫码：验证相同功能与分享发布页。

Chrome 61 JS/CSS 兼容性及真机性能尚未实测。白名单配置与这三项容器验证由用户完成；本轮没有登录平台、上传或启动真机测试。
