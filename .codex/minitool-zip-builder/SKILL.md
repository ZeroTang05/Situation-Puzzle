---
name: minitool-zip-builder
description: >-
  小红书小工具构建开发指南：把 H5 页面打包成符合容器规范的离线 zip。
  新建或改写小工具 / H5 页面、打包小工具 zip、处理端能力限制与容器 CSP 约束时使用。
metadata:
  version: "1.6.0"
---

# 小工具 ZIP 构建指南

**小工具是一种基于离线 H5 实现的 app 形式**：你写一套标准网页（以 `index.html` 为入口），打包成 `.zip`，由容器（PC 模拟器 / 真机 WebView）加载运行。它本质就是 Web，HTML/CSS/JS 经验直接适用——只是运行在受控容器里：**纯本地、不联网，所有资源须打包在内**，且部分 Web 能力被收紧。

目标产物：可直接上传的 **`.zip` 静态包**，并附带创服平台模拟器、Android 真机和 iOS 真机的验证提醒。

## 何时使用

- 从零新建小工具页面并打包成 `.zip`
- 将已有纯 H5 页面改写为小工具规范并打包

## 工作流程

开始任何实现前，优先完成在线端能力发现；后续每一步动手前再读对应 reference，不要凭记忆产出：

1. **获取当前规范** — 每个任务开始时先获取 [小工具在线文档](https://miniapp-sandbox.xiaohongshu.com/minitool/doc)，确认当前容器规则与实现所需能力；同一任务只获取一次。若受网络或沙箱限制无法访问，按当前工具的授权机制请求用户仅批准访问该链接和在当前工作区保存文档副本；不得试图绕过限制。授权后仍无法获取时，读取 [js-api.md](references/js-api.md) 作为本地 API 快照；远程文档成功获取后始终以远程内容为准
2. **优先匹配容器能力** — 实现每项需求前，先在远程文档中查找匹配的容器能力；远程文档不可用时改查 [js-api.md](references/js-api.md)。文档明确支持时必须优先使用，仅在没有匹配能力或当前环境不满足文档条件时才采用兼容的 Web 方案
3. **编写 / 适配 HTML** — 先读 [zip-artifact-spec.md](references/zip-artifact-spec.md)：目录结构、`index.html` 模板、路径与资源引用规则，按其编写
4. **端能力合规** — 先读 [device-capabilities.md](references/device-capabilities.md)：对照「不可用能力 / 行为」逐项核对；存在在线文档声明的替代能力时按文档改写，否则移除不可用能力
5. **JS 兼容性** — 先读 [js-compatibility.md](references/js-compatibility.md)：以 Android 8.1 出场 Chrome / WebView 61 为最低基线；直接交付的 JS 可使用 ES2017，更新语法须由已有构建链转译，Web API 须做能力检测
6. **CSS 兼容性** — 先读 [css-compatibility.md](references/css-compatibility.md)：采用“Chrome 61 基线层 + 能力检测增强层”；只为实际使用的新能力提供局部回退，不维护两套完整 CSS
7. **跨端适配** — 先读 [cross-platform-h5.md](references/cross-platform-h5.md)：触摸、滚动、安全区、PC vs 真机差异
8. **性能设计** — 先读 [performance-budget.md](references/performance-budget.md)：控制源码 / 静态数据 / Base64 / 媒体体积；使用 WebGL 时必须控制 GPU 资源，并提供运行时降级
9. **正确性自查** — 静态核对页面能正常运行、无违规能力（被禁 API 无调用 / 残留、脚本加载顺序、引用资源都在 zip 内、改写时未误改业务逻辑），见 [zip-artifact-spec.md](references/zip-artifact-spec.md) 自检清单
10. **审计并打包** — 按 [performance-budget.md](references/performance-budget.md) 的环境分支选择 Node、Python 或人工审计；修复全部错误，逐条核对各 reference 末尾的自检清单后生成待上传 zip。审计脚本是辅助工具，不得因运行时缺失跳过门禁
11. **创服平台与真机验证提醒** — 交付时提醒用户：将本次生成的 zip 上传至创服平台，先在平台模拟器完成完整功能验证，再分别使用 Android 真机和 iOS 真机扫码验证相同产物。除非用户明确授权且当前环境具备对应能力，否则不得主动尝试登录创服平台、上传产物或启动真机验证；将这三项标记为待用户验证，不阻塞 zip 交付

> **浏览器直运行不可信**：仅将代码在普通浏览器中直接运行所得结果不可置信，不得作为小工具功能、兼容性或交付验收的依据。交付时再次提醒用户完成创服平台模拟器、Android 真机扫码与 iOS 真机扫码验证。

> **产出前提**：交付的 zip 必须同时满足 `zip-artifact-spec.md`、`device-capabilities.md`、`js-compatibility.md`、`css-compatibility.md`、`performance-budget.md` 与小工具在线文档的全部约束；交付说明必须包含创服平台模拟器、Android 真机扫码与 iOS 真机扫码验证提醒。

## Reference

| 文档 | 何时读 |
| --- | --- |
| [小工具在线文档](https://miniapp-sandbox.xiaohongshu.com/minitool/doc) | 每个任务开始时优先获取：以当前页面为准实现所需能力与容器规则 |
| [js-api.md](references/js-api.md) | 远程文档经授权仍无法获取时：使用本地 API 快照；远程文档恢复可用后以远程内容为准 |
| [zip-artifact-spec.md](references/zip-artifact-spec.md) | 写 HTML / 打包时：目录结构、`index.html` 模板、路径与资源引用规则、打包自检 |
| [device-capabilities.md](references/device-capabilities.md) | 处理端能力时：哪些 Web 能力可用 / 不可用及替代写法、如何实现常见交互（手势、拍照、选图等） |
| [js-compatibility.md](references/js-compatibility.md) | 写 JS / 选择构建产物时：Android 8.1 出场 Chrome / WebView 61 最低基线、Web API 检测与局部降级 |
| [css-compatibility.md](references/css-compatibility.md) | 写 CSS / 选择构建产物时：Chrome 61 基线、能力检测、现代 CSS 增强与局部回退 |
| [cross-platform-h5.md](references/cross-platform-h5.md) | 适配多端时：触摸、滚动、安全区、PC 模拟器与真机差异 |
| [performance-budget.md](references/performance-budget.md) | 开发和交付前：包体、静态数据、Base64、媒体、长列表与 WebGL 资源控制和降级 |
