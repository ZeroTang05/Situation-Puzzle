# 超好玩海龟汤 · TapTap H5 小游戏

直接构建 `apps/web` 的现有 React 页面、样式和全部路由。H5 草稿为稷策游戏下的 `1059905`，小游戏标识为 `tapmcowiubozfhhvw5`，身份见 `h5.config.json`。

```powershell
pnpm dev:taptap
pnpm build:taptap
pnpm package:taptap
```

开发预览通过 Vite 代理连接真实生产 API。上传的 H5 构建直接访问 `https://sp.xiaobaozi.cn`，服务器 `APP_EXTRA_ORIGINS` 已放行平台来源 `https://ma-h5-al.tapimg.com`。调试构建（`pnpm build:taptap:debug` / `pnpm package:taptap:debug`）包含源码映射和 vConsole 的脱敏诊断面板；正式产物排除调试工具。

归档为 `artifacts/h5.zip` 与 `artifacts/h5-debug.zip`，均只有一个顶层 `game/` 目录。

## TapTap 适配

- **登录**：H5 构建的登录页只渲染「TapTap 一键登录」。TapTap 容器注入 `window.tap`，`tap.login` 拿临时 code，服务端 `POST /auth/taptap-mini/login` 走官方 code2Session 换 openid 建号建会话，令牌按 H5 的 Bearer 链路保存；普通浏览器无 tap 桥时提示「请在 TapTap 中打开」。服务器需配置 `TAPTAP_MINI_APPID` / `TAPTAP_MINI_SECRET`，配置见 [配置清单](../../docs/rebuild/22-TAPTAP-CONFIG.md)。
- **防沉迷**：由 TapTap 平台统一实名认证系统在登录链路执行（未实名禁止登录、未成年人时段时长限制），小游戏体系无开发者侧防沉迷 API，登录失败按稳定错误码翻译提示。
- **充值**：TapTap H5 隐藏打赏购买面板（与 App 壳同策略），兑换码保留在设置页。

2026-11-16 移除了原生 Canvas 版本与设备授权流程（`/device` 页、`device_code` 表由迁移 `0019` 删除）；TapTap 一键登录保留并服务 H5。历史代码见 git 记录，验收记录见 [开发记录](../../docs/rebuild/22-TAPTAP.md)。
