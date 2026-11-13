# TapTap 开发包配置清单

更新时间：2026-11-13。

## 服务器必填

配置写入生产服务器项目目录的 `.env`；本地文件有值不会自动同步到服务器。

```dotenv
TAPTAP_MINI_APPID=tapmcmnlmv6v8lx5mb
TAPTAP_MINI_SECRET=填写这个小游戏的实际 AppSecret
PUBLIC_BASE_URL=https://sp.xiaobaozi.cn
```

AppSecret（小游戏密钥）从 TapTap 后台本小游戏的开放能力配置取得。不要使用商店游戏编号 `1046017` 替代 MiniApp ID，也不要把密钥放入 `apps/taptap/config.json` 或小游戏包体。

现有数据库、会话密钥、AI 和邮件配置继续复用：

| 配置 | 用途与处理 |
| --- | --- |
| `DATABASE_URL` | 实际数据库连接；Docker Compose 部署由数据库用户名、密码和库名拼出 |
| `AUTH_SECRET`、`SOLO_TOKEN_SECRET` | 现有会话、单人凭证签名密钥，保留已有值 |
| `MINIMAX_API_KEY`、`OPENCODE_API_KEY` | 复用现有真实判题服务凭据 |
| `MAIL_TRANSPORT`、`MAIL_FROM` | 真实邮件通道和发件地址 |
| `RESEND_API_KEY` | 生产使用 `MAIL_TRANSPORT=resend` 时填写 |
| `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS` | 使用真实 SMTP 邮件通道时按邮箱服务商要求填写；本地收信台不能承担生产发信 |

`BETA_OPEN_ROOM=true` 会让当前部署的全部用户不限次数开房，影响网页和其它共用服务端的客户端；这是可选的内测开关。

## 小游戏已填好的公开配置

文件：`apps/taptap/config.json`。

| 字段 | 当前值 | 处理 |
| --- | --- | --- |
| `storeAppId` | `1046017` | 保留 |
| `developerId` | `529328` | 保留 |
| `miniAppId` | `tapmcmnlmv6v8lx5mb` | 保留 |
| `apiBaseUrl` | `https://sp.xiaobaozi.cn` | 保留，必须指向实际部署服务的 HTTPS 来源 |
| `shareTemplateId` | `ST17942513326525WIWIJHXW` | 已有分享模板，保留 |
| `interstitialAdUnitId` | 空字符串 | 广告暂缓，保持为空 |
| `rewardedAdUnitId` | 空字符串 | 平台服务端奖励核验尚未接通，必须保持为空 |

改动客户端公开配置后需要重新构建、上传新的开发包。修改服务器密钥后需要更新服务环境并重建 API 容器，客户端无需因此改包。

## 部署与连接

1. 部署当前 API 与网页代码，执行全部追加式数据库迁移；其中 `0018_device_authorization.sql` 用于官网账号确认登录。
2. API 与 jobs（后台任务进程）均需正常运行，多人 AI 判题依赖任务进程。
3. HTTPS 业务请求使用 `https://sp.xiaobaozi.cn/api/v1/`，实时连接使用 `wss://sp.xiaobaozi.cn/ws`，网关需正确代理 WebSocket 升级。
4. 官网账号确认页面为 `https://sp.xiaobaozi.cn/device`。
5. 部署后在实际 TapTap App 验证登录、单人判题、双人实时同步和官网账号确认。

2026-11-13 实际检查：线上健康接口返回 200，向 `/api/v1/auth/taptap-mini/login` 提交空对象返回 404，当前线上尚未提供可用的 TapTap 登录入口。该检查未使用真实用户凭证，也未创建账号。需先部署代码并配齐服务器 TapTap 凭据，再用真实宿主登录凭证完成验收。

## 提审前的平台资料

开发版本可先创建。正式提审仍需补齐真实截图、实机录屏、宣传素材以及 AI、隐私、适龄和平台要求的资质资料。具体缺项以后台实时检查为准。

广告暂缓不影响创建开发包；广告收入需后续接通真实媒体和广告位后才能验证。
