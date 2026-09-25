# docs/

这个目录放项目设计文档、截图与外宣素材。

## 新版产品与架构

[多人海龟汤开发文档入口](rebuild/README.md)：包含 PRD（产品需求）、MVP（首发范围）、SPEC（技术规格）、房间同步、单人本地记录、赞助与后台、代码和数据迁移，以及开发验收清单。

## 宣传视频素材

`video-assets/` 收着宣传视频的截图、架构图和口播稿：13 张素材图按镜号编号，`口播稿.md` 里有分镜表、游玩录屏拍摄清单和每个数字的出处。架构图用 `scripts/render-video-diagrams.mjs` 渲染（mermaid 源码在脚本里，改完重跑即可）。

## 待补

- `screenshot-play.png` — 游戏主界面（手机宽度）
- `screenshot-solve.png` — 还原真相界面
- `screenshot-create.png` — 出题表单
- `screenshot-admin.png` — 审核后台

建议尺寸：750×1334 (iPhone 8 模拟器) 或 1080×1920。控制在 200KB 以内。

如果想贡献一张截图，欢迎发 PR 或在 Issue 里附图。
