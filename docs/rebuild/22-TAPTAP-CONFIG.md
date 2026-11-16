# TapTap 开发包配置清单

## 当前 H5 配置（2026-11-14）

当前 H5 草稿为 `1059905`，小游戏标识 `tapmcowiubozfhhvw5`，身份记录在 `apps/taptap/h5.config.json`。构建复用 `apps/web`，`pnpm build:taptap` 生成正式包，`pnpm build:taptap:debug` 生成带日志工具和源码映射的开发包。

H5 构建中的 API 默认指向 `https://sp.xiaobaozi.cn`，可用公开构建变量 `VITE_API_BASE_URL` 指定其它实际 HTTPS 来源。取得平台真实运行来源后，服务器 `APP_EXTRA_ORIGINS` 追加该精确来源，多个来源用逗号分隔。已有来源应保留，配置更新后需重建 API 容器。

2026-11-14 已从真实手机请求的服务端日志确认平台来源为 `https://ma-h5-al.tapimg.com`。生产配置已更新为 `APP_EXTRA_ORIGINS=https://localhost,https://ma-h5-al.tapimg.com`，并重新创建 API 容器使配置生效。真实浏览器在该平台来源下读取题库、创建单人局和请求 AI 判题均返回 200。当前开发包可直接重新进入验证。

匿名单人使用现有题库与 `/solo/*` 接口。H5 账号会话复用网页与 App 现有的 Bearer 机制，在平台来源独立保存本站令牌。账号与多人流程在单人验收后继续验证。

`pnpm dev:taptap` 使用开发代理连接真实 API，便于电脑调试。正式包直接跨来源访问服务器，必须在实际 TapTap 内验证来源、证书与预检响应。

## 服务器配置（H5 登录）

配置写入生产服务器项目目录的 `.env`；本地文件有值不会自动同步到服务器。

```dotenv
TAPTAP_MINI_APPID=tapmcowiubozfhhvw5
TAPTAP_MINI_SECRET=填写这个小游戏的实际 AppSecret
```

AppSecret 从 TapTap 开发者后台本小游戏的开放能力配置取得。两项同时配置才注册登录端点 `/api/v1/auth/taptap-mini/login`；只填一项在启动期报错。AppSecret 只放服务器，不进入 H5 构建产物。

现有数据库、会话密钥、AI 和邮件配置继续复用；`BETA_OPEN_ROOM=true` 是可选的内测开关（影响全部共用服务端的客户端）。

## 原生版本历史配置

`apps/taptap/config.json` 公开配置与 `/device` 部署步骤已随 2026-11-16 的原生代码移除一并删除，`device_code` 表由迁移 `0019` 删掉。原生时期的配置细节见 git 历史中的本文档旧版。

## 提审前的平台资料

开发版本可先创建。正式提审仍需补齐真实截图、实机录屏、宣传素材以及 AI、隐私、适龄和平台要求的资质资料。具体缺项以后台实时检查为准。

广告暂缓不影响创建开发包；广告收入需后续接通真实媒体和广告位后才能验证。
