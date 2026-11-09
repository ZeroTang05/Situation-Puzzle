# 20 — 微信小程序版本计划

状态：已拍板（决策记录见 §8）。M0–M2 完成（2026-10-25）；M3（多人）、M4（社交）、M5（创作）完成（2026-11-07，未提交待真机验收）；M6 支付引导与 M7 提审待做。
日期：2026-10-25；基线：feat/app-version（含 M3 Android 交付）。

## M3–M5 完成记录（2026-11-07：多人 / 社交 / 创作三个分包）

网页端剩余路由一比一移植进三个分包（分包 = 用到时才下载的代码块，主包体积不受影响）：
`pkg-room`（会客厅 / 房间 / 邀请落地 / 大厅，24 文件）、`pkg-social`（好友 / 私聊 / 通知中心 +
主包铃铛组件）、`pkg-creation`（作品列表 / 编辑器 / 预览私测）。实时房间流照抄 web 的
`use-room-sync`（票据 + auth 帧 + 指数退避重连 + seq 去重补齐 + outbox 可靠发送），传输层换
`Taro.connectSocket` 的 SocketTask（`wss://sp.xiaobaozi.cn/ws`），页面隐藏断连、回前台重连。

**邀请交互（用户拍板）**：会客厅与房间各一个「邀请」按钮，点开底部菜单（自绘 bottom sheet）：
「邀请微信好友」用 `<Button openType="share">` 发小程序卡片（微信规定 API 调不起转发），
`useShareAppMessage` 的 path 带邀请 token 与邀请码 ref；「复制链接」复制网页版邀请 URL。

主包接入：首页「多人」真开会客厅、次要入口补大厅 / 我的作品 / 好友、进行中的房间列表；
题库支持 `?mode=select` 会客厅选题与「再来一题」，普通模式卡片加「开房」；「我的」加作品 / 好友
入口、历史行可点进房间；首页顶栏接通知铃铛（10s 轮询）。

构建新增两处：① `config/index.ts` webpackChain 加 `extensionAlias {'.js':['.ts','.js']}`——分包
第一次把 `@jev/contracts` 的运行时值（Zod schema）打进包，contracts 是 Node ESM 风格 TS 源码
（`./errors.js` 实为 errors.ts），webpack 需要显式扩展名别名；② `room.css` 注释里 `:nth-*/` 的
`*/` 会提前终结 CSS 注释导致压缩器报错，已改写。`scan-weapp-syntax.mjs` 白名单新增 `atob`
（zod v4 内建 base64 校验器，try/catch 包裹，契约未用 base64 格式）。

截图验收（未登录态）：17 页全部渲染正常；修掉三处 review 发现的问题——编辑器未登录顶栏
「我的作品」改回返回按钮（左上角一律返回）、通知页未登录隐藏「全部已读」、私聊页未登录隐藏
「来一局」（wide-actions 网格的空右列会把标题挤偏，未登录时回落基础三列网格）。
残余小瑕疵：编辑器未登录态标题仍有约 15px 偏右（同结构的列表页居中正常），待真机复查。

与 web 的已知差异（环境所限，功能等价）：Enter 发送未移植（软键盘回车不可靠，走按钮）；
web 的 pointerdown 收起管理面板改为点遮罩收起；脏表单离开拦截只在返回按钮上二次确认
（小程序页面卸载不可拦）；创作「游玩」开局语言取界面语言（web 的 `?lang=` 参数 web 端自己也未消费）。
真机待验证：SocketTask auth/close(4401/4403) 时序、微信转发卡片落地产道、双端同桌对局。

### E2E 联调记录（2026-11-07：开发者工具自动化直连生产，修掉三个页面级瘫痪 bug）

常驻 E2E 设施：`apps/miniprogram/scripts/mp-e2e.mjs`（12 模块：login/home/library/solo/
lobby/room/hall/friends/chat/notifications/creations/me，可单跑重跑；配套 `mp-probe-restart.mjs`
重启工具并验证渲染、`mp-probe-console.mjs` 抓启动期报错）。跑法：开发者工具 CLI `auto` 拉起
（自动化端口 9420）后 `node scripts/mp-e2e.mjs <输出目录> [模块...]`。12 模块全部功能验证通过；
个别断言在现场偶发红字，定向探针复测均正常（IDE 自动化桥的 webview 通道错乱，属环境噪音）。

三个 bug 都是「主包正常、分包/功能瘫痪」级别，E2E 逐个实锤：

1. **zod v4 的 JIT 编译在小程序崩溃 → 所有分包页面白屏**（主包正常、分包 view=0、零报错）。
   zod 首次 `parse` 会把 schema 编译成函数（fastpass），依赖 Function 动态编译，小程序运行时
   不支持。修法：`polyfills.ts` 抢在 zod 加载前写 `globalThis.__zod_globalConfig = { jitless: true }`
   （zod 侧 `??` 只在缺失时初始化），全局改解释执行。
2. **微信 SocketTask 没有 web WebSocket 的 `OPEN` 常量** → `readyState === socket.OPEN` 永假 →
   auth 帧发不出 → 房间同步永远「加载中」。修法：`use-room-sync.ts` 三处改 `readyState === 1`。
3. **Taro 小程序 app.tsx 自身渲染的兄弟节点不上屏** → 全局 DialogHost 是死代码 → 所有
   `dialog.confirm` 死锁（公布答案/解散/提交/退出登录的确认都点不动）。修法：每个用到
   useDialog 的页面（settings/solo/editor/lobby/room/friends）挂页内 `<DialogHost />`，
   app.tsx 只保留 QueryClientProvider 并注释说明。

另修：大厅行整行可点（对齐整卡可点惯例，满员房除外）；房间同步失败从静默重连改为
`console.warn` 留痕；会话请求失败仅 401 才按未登录处理（缓存最近一次会话，防启动抖动误弹登录页）。

结构约定：主包业务目录（`lobby/`、`notification/`、`game/`、`solo/`、`invite/`、`ads/`、
`state/`、`ui/`、`api/`）是被主包页面与分包页面共同引用的跨包共享代码，按「分包不能引分包」
规则必须放主包；`pkg-*` 三个目录只放分包页面。目录名与 web 对照的映射写在各文件头注释里
（rooms→lobby、social→notification 已就地改名消歧）。

验证：`tsc --noEmit -p apps/miniprogram` 0、`build:weapp` 成功、`scan-weapp-syntax.mjs` 均 0。

## M2.8 完成记录（2026-11-06：小程序端彻底移出 better-auth 客户端）

现象：登录接口已 200，但紧跟其后的 `GET https://sp.xiaobaozi.cn/get-session -> 200
text/html`——会话读不回来，表现为「登录成功立刻又显示未登录」。

根因：better-auth 客户端取址走 better-fetch 的 `new URL(path, base)`；微信运行时
没有原生 `URL`，Taro 用 ProvidePlugin **在构建期**把 `@tarojs/runtime` 的 `URL`
polyfill 注入所有依赖包（运行时改全局 URL 无效）。该 polyfill 解析「相对地址 +
绝对 base」时只保留 `base.origin`、**丢掉 base 的 path 段**——`/api/v1/auth` 前缀
消失，请求打到站点根 `/get-session`，落到 SPA 回退页（200 text/html）。

修法（对齐 `~/GoWith/apps/miniapp`：那边小程序端没有会话客户端库，只有一层自写的
request 包装）：**小程序端不再引 better-auth 客户端**。`src/api/auth-client.ts` 用
`Taro.request` 自己拼绝对地址 `${API_BASE}/api/v1/auth${path}`，不经过 URL 解析：

- 登录 `POST /wechat-mini/login` → 响应体 `{ token }` → `storeBearerToken`；
- 会话 `GET /get-session` → `{session,user}`，无令牌时服务端回 `null`（HTTP 200）；
- 登出 `POST /sign-out` → `{success:true}`；
- 错误体 `{code,message}` → `AuthError`，页面用 `displayAuthError` 按 code 翻译；
- `dataType: 'text'` + 手动 `JSON.parse`：非 JSON 响应（如 SPA 回退页）按失败处理，
  不再让 `SyntaxError` 把英文原文甩给用户。

随之删除：`src/api/fetch-adapter.ts`（taroFetch/MiniHeaders 只为桥接 better-auth
客户端）、`src/polyfills.ts` 里的 fetch/Headers/Request/Response 垫片（只剩
`AbortController`）、`legacySyntaxPaths` 里的 better-auth / @better-auth/core /
better-call 三项、`package.json` 的 `better-auth` 依赖。服务端 `wechat-mini` 插件
与 Bearer 协议不变。

同时修正 404 根因：端点 `metadata` 不能用 `SERVER_ONLY`（better-call 里它表示
**完全不注册路由**），改用 `{ scope: 'server' }`（可被 HTTP 命中、不进客户端动作列表）。

验证：`tsc --noEmit` 0、`build:weapp` 成功、`scan-weapp-syntax.mjs` 语法/未声明
全局均 0。

## M2.7 完成记录（2026-10-31 / 11-05：修复预览报错 Invalid token / Unexpected token）

微信开发者工具「预览」对 dist 里没做语法降级的 **ES2021/ES2022 新语法** 报
SyntaxError，分两轮修完（配置都在 `apps/miniprogram/config/index.ts`）：

**第一轮（私有字段 `#field`，报 Invalid token）**，来源两批修法不同：

- **`.js` 来源**（@tanstack/react-query、query-core）：`compile.include` 圈进
  Taro 的 babel 即可，这条早就生效。
- **`.mjs` 来源**（better-call 的 `error.mjs`、@better-auth/core 的 `env-impl.mjs`）：
  `compile.include` 的脚本规则对 `.mjs` 实测不生效。另挂 webpackChain 的 babel 规则
  （`legacy-syntax-mjs`），并且 **babel-loader 必须显式传
  `{ cwd: appDir, configFile: <应用>/babel.config.js }`**——不带 options 时
  babel-loader 按「被编译文件」的位置向上找配置，`.pnpm` 深处的文件找不到应用的
  babel.config.js，等于零预设空转、原样输出（这是本次卡最久的一步：构建日志看着
  在编译、产物里 `#field` 纹丝不动）。

**第二轮（逻辑赋值 `||=`，报 Unexpected token =）**：修完第一轮预览换了报错
位置，定位到 **nanostores**（Taro 的传递依赖，`globalThis.nanostoresGlobal ||=`
一处）——微信预览器对 ES2021 逻辑赋值同样不认。nanostores 是 .js，加进
`legacySyntaxPaths`（从 @tarojs/taro 的目录解析）走 `compile.include` 即解决。

**第三轮（编译过了，运行时浏览器全局缺失连环炸）**：语法清零后代码第一次
真正跑起来，先后报 `Request is not defined` → `fetch is not defined`，全部出自
better-auth 初始化链（`dist/client/config.mjs`：`"credentials" in
Request.prototype` 特性检测 + `customFetchImpl: fetch` 对象字面量求值）。用 AST
作用域分析把 dist 全量扫了一遍，真正会炸的浏览器全局共 **5 个**，统一在新增的
`src/polyfills.ts` 补齐（app.tsx 首行 + auth-client.ts 双保险 import，先于一切
使用方执行；已有原生实现的环境不覆盖）：

- `fetch` → 补真实现（taroFetch 本来就是 fetch 形状，走 Taro.request）；
- `Headers` → 补 **MiniHeaders 真实现**（fetch-adapter.ts 导出、polyfills.ts
  注册全局，taroFetch 响应头同款）。第一版空壳类不够：better-fetch 处理响应
  会 `new Headers(...)` 后调 `.has('content-type')` 判断解析方式，空壳直接
  `t.has is not a function`（真机报错实锤后才升级，教训：polyfill 的类要按
  「库会真用哪些方法」评估，不能只看 instanceof）；
- `Request` / `Response` → 补空壳类（目前只被 instanceof/能力检测碰到）；
- `AbortController` → react-query 观察器构造时 `new` 它做查询取消，补最小
  实现（signal 状态 + abort 监听）。真机上必炸（开发者工具的 Chromium 内核有、
  真机运行时没有），属于「工具里正常、真机炸」的典型差异。

**第四轮（真机 `t.has is not a function` + 登录提示 unexpected end of JSON
input）**：前者即上面的 Headers 空壳问题；后者是登录接口回了空响应体，
`json()` 对空串 JSON.parse 抛 SyntaxError 且英文原文被直接展示。登录页改用
LoginError 区分「已翻译文案」与「意外异常」，意外异常统一回落通用文案
（login.tsx）。空响应体的服务端原因大概率是生产未部署 wechat-mini 端点——
联调前置：部署带端点的新代码 + 配 WECHAT_MINI_APPID/SECRET（配齐才注册）+
小程序后台配 request 合法域名（sp.xiaobaozi.cn）。

**第五轮（真机调试 zod 报 `Unexpected token ?`，模拟器一直正常）**：真机调试
在分包 `pkg-creation/sub-common/` 报 SyntaxError，AST 归因确认 14 个残留 chunk
全部来自 **zod v4**（contracts 的传递依赖，经跨分包共享模块抽取进三个分包的
`sub-common/`）。zod 发空值合并 `??` 与可选链 `?.`（ES2020），不在
`legacySyntaxPaths` 里、从未被 babel 降级。此前一直没炸是因为 **IDE 模拟器是
Chromium 内核认识 ES2020**，E2E 全绿掩盖了问题；真机 JS 引擎不认才炸。修法与
第一轮同款：`config/index.ts` 从 `@jev/contracts` 的包根解析出 zod 真实路径加进
`legacySyntaxPaths`（传递依赖要经依赖它的包解析，pnpm 隔离下 app 目录直接
resolve 不到）。同轮把扫描器语法检查从四类扩到**六类**（补空值合并 `??` 与
可选链 `?.`，`?.` 在模拟器同样能跑、必须靠扫描器把关），zod JSON Schema 导出里
`instanceof File` 的未执行分支登记白名单。

其余被扫出的名字（performance/setImmediate/MessageChannel/window/process/
Deno/Bun/localStorage/btoa/File 等）各有 `typeof` 守卫、try/catch 或分支不执行，
确认安全。**扫描器已升级为双检查**（`scripts/scan-weapp-syntax.mjs`）：①语法
六类；②未声明全局引用（作用域分析 + JS 内建/微信宿主白名单 + typeof 守卫识别
+ 应用 polyfill 登记），`build:mp` 后跑一次，两类均 0 通过——加新依赖后必跑，
能把「预览逐个报错」的循环掐死在构建后。

排查与验证工具沉淀为 **`scripts/scan-weapp-syntax.mjs`**：`build:mp` 之后跑，
用 @babel/parser 解析 dist 全部 js、AST 级找出六类真机不认的节点（class 公有/
私有字段、私有方法、静态块、逻辑赋值、空值合并、可选链），0 处通过。比等预览
逐个报错快得多，新加依赖后建议跑一次。排查方法论也记一笔：看报错位置的真实
代码片段归因来源包（别信打包时的第一直觉，第一轮真凶 better-call、第二轮
nanostores、第五轮 zod 都与最初怀疑对象不同）；pnpm 真实路径带哈希没法写死，
`legacySyntaxPaths` 在配置加载时动态解析（包 exports 不暴露 `./package.json`
时要解析主入口后向上找包根；传递依赖从依赖它的包出发解析）。

## M2.6 完成记录（2026-10-27：登录换微信一键登录）

登录方式整体切换：**去掉邮箱登录/注册/找回密码，小程序端只留微信一键登录**
（web/App 端不受影响，邮箱通道照旧）。

- **后端**（`apps/api/src/auth/wechat-mini.ts`）：better-auth 自定义插件，
  端点 `POST /api/v1/auth/wechat-mini/login`。服务端直连
  `api.weixin.qq.com/sns/jscode2session`（AppSecret 只在服务端；境内服务器无需中继）
  换 openid → 按 `(providerId='wechat-mini', accountId=openid)` 找账号，没有就
  `createOAuthUser` 建号（占位邮箱 `wx-<openid>@wechat.invalid` 沿用 LINUX DO 的
  `*.invalid` 约定；昵称走注册钩子默认「用户+随机编号」；注册礼/免费账户/赞助账户
  钩子照常生效）→ `createSession` 后令牌放**响应体**（小程序无 Cookie，与 App 壳
  Bearer 链路同约定，客户端 `storeBearerToken` 直存）。并发双击撞唯一索引时重查兜底。
  `session_key` 不落库（本站不解密微信侧数据）；`unionid` 暂不存（站内只有小程序一个
  微信入口，openid 已唯一；接公众号/网站微信登录时再引入列做跨端合并）。
  凭据 `WECHAT_MINI_APPID` + `WECHAT_MINI_SECRET` 两项配齐才注册插件，缺一项端点不存在。
  频控吃 better-auth 全局默认（20 次/分钟/IP）。微信错误码映射：40029/40126 →
  `WECHAT_LOGIN_FAILED`（code 无效/已用，让用户重走 wx.login）、45011/-1 →
  `WECHAT_LOGIN_BUSY`（微信侧限流/繁忙）。
- **小程序端**：登录页重写为单按钮（`Taro.login()` → 插件端点 → 存令牌 →
  finishLogin），登录卡片下方留隐私政策入口（提审友好）；删除邮箱登录/注册/找回密码
  页与 OTP 倒计时模块（`pages/forgot-password`、`auth/otp-cooldown.ts`）；
  `authClient`（better-auth vanilla 客户端）保留——会话读取/刷新/登出仍走它
  （**M2.8 已移除**，改为自写 `src/api/auth-client.ts`，见上）。
  「我的」页邮箱展示脱敏：占位邮箱显示为「微信账号」。
- **账号体系口径**：微信登录建的是独立账号，与 web 邮箱账号互不相通（原「邮箱登录
  天然同步」路径随邮箱登录一起移除）；跨端权益同步靠兑换码（全端保留）。将来要打通
  时在设置页加「绑定邮箱」即可（account 表多 provider 天然支持）。
- 验证：全仓 typecheck 全绿、`build:weapp` 成功、`parseCode2Session` 单测 4 项通过
  （`apps/api/src/auth/wechat-mini.test.ts`）。真实链路待 AppID/AppSecret 配置后联调。

## M2.5 完成记录（2026-10-24 补充：奖励入口）

变现方式修订（21 号文档）落在小程序侧的部分：

- **邀请好友**：「我的」页邀请卡（邀请码 + 已邀人数 + 复制网页链接 + `openType="share"`
  转发按钮）；首页与我的页注册 `useInviteShare`（`src/invite/share.ts`），分享路径带
  `?ref=<邀请码>`；好友从分享进站 → 首页捕获 ref 存 Taro storage（页面参数与启动参数
  双来源）→ 登录后静默 `POST /invites/claim`（奖励 +5 发给邀请人）
- **看广告 +2 次**：「我的」页额度卡下方（非会员且非内测期显示），`src/ads/rewarded-ad.ts`
  完整实现意图令牌 → 激励视频 → 服务端验证回调入账链路；`AD_UNIT_ID` 占位为空，
  流量主开通（UV ≥ 1000）后填入即生效，开通前点击提示「广告通道开通中」
- **内测期徽标**：`/me` 返回 `betaOpen` 时额度卡显示「内测畅玩中」（替代具体数字）
- 坑：Taro 应用入口 `app.tsx` 经 webpack 特殊编译，从它导入值会丢
 （ModuleDependencyWarning）——全局 queryClient 放独立模块 `src/state/query-client.ts`

## M2 完成记录（2026-10-25：题库与单人）

- **题库页**：筛选（排序/难度/类别胶囊）+ 分页（上一页/页码/下一页）+ 已玩标记 + 署名与赞踩计数 + 单人开局入口；URL 参数换组件 state，翻页 keepPreviousData 平滑过渡（与 web 同款 react-query 配置）
- **单人游玩全流程**：开局（POST /solo/sessions 匿名凭证）→ 提问（带最近 10 轮已判定问答，供判题解析代词）→ 是/否/无关/无法确定判定徽标 + 置信度 → 还原（可开大模型 MiniMax 补判）→ 提示胶囊（3 条翻阅）→ 公布汤底（showModal 二次确认）→ 解出结算 / 揭晓面板 → 换题（游标翻全库随机抽未玩题，redirectTo 不堆栈）；退出重进按题目+语言恢复本地对局与输入草稿
- **本地存储**：`src/solo/local-store.ts` 的 soloStore 与 web 同名同形接口，IndexedDB 换 Taro storage KV 布局（会话/进度各一个 key、问答按会话分 key 存 JSON——单 key 1MB 上限内安全）；session-selection / unplayed-puzzle 纯函数逐字复用
- 游玩组件（TurnCard 问答气泡 / HintCapsule 提示胶囊 / LargeModelToggle 微信原生 Switch）抽在 `src/game/components.tsx`，后续多人房间直接复用
- **小程序差异**：题目评价（赞踩投票）随社交里程碑接入（本期只读计数）；错误提示用页面内悬浮条 4 秒自动消失（对齐 web Toast 行为）；换题请求用取消标志代替 AbortController（小程序无此 API）
- 验证：全仓 typecheck 全绿、`build:weapp` 成功（总包 578K，vendors 76K / app 104K / common 63K）、check-deps 无违规

## M1 完成记录（2026-10-25：认证与账号）

- **better-auth 客户端进小程序**：用 vanilla 入口 `better-auth/client`（已验证 1.7.6 的 dist/client/index.mjs 与 plugins 不依赖 DOM；react 入口的 useSession 体系要 BroadcastChannel/focus 等浏览器 API，进不来）。`src/api/fetch-adapter.ts` 把 Taro.request 包成 fetch 形状（ok/status/headers.get/json/text），统一附加 Bearer 与语言头、捕获 set-auth-token；`createAuthClient` 配置与 web 端同形。会话 hook 自建（`src/state/session.ts`：挂载拉取 + eventCenter 广播 + onShow 重拉）
- 页面（状态机与 web 同源逐行移植，减 OAuth）：登录（密码/验证码双 tab + 注册四步流程 + 发码倒计时）、忘记密码、设置（昵称 PATCH /me/nickname、语言、兑换码、隐私入口、退出登录——确认用微信原生 showModal）、隐私政策（静态双语，本地存储一节按小程序措辞）、我的（账号卡 + 额度/会员数字 + 多人历史分页）。文案全部来自 `@jev/i18n` 的 `t()`，零自建键
- **与 web 的三处环境差异**：① Google / LINUX DO 登录不提供（授权跳转需要系统浏览器承接回调）；② 重置密码链接落回**网页版** `/reset-password`（邮件链接只能在外部浏览器打开，小程序无深链承接 token，设置新密码在网页完成）；③ 首页顶栏按会话状态切换「登录/我的」入口
- react-query Provider 挂进 `src/app.tsx`（retry: false、关 refetchOnWindowFocus；JSX 须用 .tsx 扩展名）
- 验证：全仓 typecheck 全绿、`build:weapp` 成功（总包 530K，vendors.js 76K，远低于 2MB 限制）、check-deps 无违规
- **两个类型坑（better-auth 1.7.6）**：① `customFetchImpl` 按 FetchEsque 检查（参数须能接受 `Request`/`RequestInit`），适配器签名直接标 `typeof fetch`（@types/node 提供 undici 同形全局）——签名不兼容会让 createAuthClient 的插件泛型推断整体失败，`authClient.emailOtp` 全部报不存在；② `better-auth/client`（index 入口）会连带打包 broadcast-channel/focus-manager 等 react 入口模块，但它们的浏览器访问都在 `typeof window === "undefined"` 守卫的方法体内，小程序运行安全（产物里的 localStorage 字符串是死代码路径）

## M0 完成记录（2026-10-25）

- 工程落位 `apps/miniprogram`（@jev/miniprogram）：Taro 4.3.1 + React 18 + webpack5，只编译 weapp；`pnpm dev:mp` / `pnpm build:mp` 挂根脚本；样式不用 sass（纯 CSS），designWidth 375 让 px 值与 web 一致
- 适配层：`src/api/client.ts`（Taro.request + Bearer 令牌链路 + 语言头 + 统一信封/错误码，translateApiError 同款）、`src/state/language.ts`（Taro storage + eventCenter 跨页同步）；设计变量与基础控件类（btn/panel/field/verdict 徽标…）从 @jev/ui theme.css 平移进 `src/app.css`（:root→page、去 hover、压 button::after）
- 首页静态骨架（hero 区一比一），入口后续里程碑接通
- 验证：`tsc --noEmit` 全绿、`build:weapp` 成功（主包 381K，远低于 2MB 限制）
- **pnpm 严格模式四个坑（都已固化进配置）**：① webpack5-runner 的 peer 声明 webpack **精确 5.91.0**，写 `^5.91.0` 装新版会被 pnpm 拒链接（MODULE_NOT_FOUND）——devDep 钉死 `5.91.0`；② babel-preset-taro 假设宿主装了 @babel/preset-react，须在 app devDeps 显式声明；③ workspace 包（@jev/contracts/i18n）是 TS 源码导出，须 `mini.compile.include` 圈进编译（真实路径 packages/* 与符号链接 node_modules/@jev/* 都要，注意 config/ 的 `__dirname` 往上三级才是仓库根）；④ pnpm 10 默认拦安装脚本，根 package.json `pnpm.onlyBuiltDependencies` 放行 esbuild/@swc/core/@tarojs/cli 等 7 个包
- 微信开发者工具导入 `apps/miniprogram` 目录（project.config.json 已配 touristappid 占位，换真 AppID 即可）

## 0. 结论

用 Taro（React）把现有产品**功能一比一**重写成微信小程序端 `apps/miniprogram`，后端零改动（认证直接复用 App 版做好的 Bearer 令牌链路），contracts / i18n 两个纯 TS 包整体复用，界面层按小程序运行时重写。主体是用户的**个体工商户 + 微信商户号**。

「一比一」的边界说明：小程序不是浏览器，跑不了现有网页代码（无 DOM / 无 Cookie / 无 IndexedDB），所以复刻的是**功能、信息架构与视觉**，界面代码全部重写。web-view 套壳路线（真正像素级一比一）已被排除——它同样要企业主体，且套壳审核通过率低，重写还能换来原生手感与后续微信登录。

## 1. 硬约束（2026-10-25 查证）

| 约束 | 现状与对策 |
| --- | --- |
| AI 类目：微信不开放**个人开发者**报「深度合成」类目（2025-12 官方口径） | 主体为个体工商户，可申报；申报材料需 AI 能力提供方的算法备案证明 + 合作协议——判题以 **MiniMax**（国内已备案）名义申报，SystemOne（境外，无备案）不出现在申报材料里 |
| 内容审核：恐怖/灵异题材是小程序巡查重点，446 题大量凶杀死亡题材 | 默认**全量先上**；若被拒，预案 = 小程序端隐藏变格分类 + 收敛个别极端题面（服务端加渠道过滤，或前端隐藏入口），见 §7 |
| 支付：小程序内虚拟商品 iOS 端被微信禁止；JSAPI 支付需商户号绑定小程序 AppID | 商户号已有（个体工商户）。M6 先做「展示 + 复制链接去网页购买」（赞助码通道兜底），JSAPI 直付 Android 端为增量项 |
| 域名：request / socket 合法域名须 https/wss 且已备案 | sp.xiaobaozi.cn 境内服务器，https/wss 均已就绪；小程序后台配置即可 |
| 包体：主包 2MB（分包后单包 2MB / 总 20MB） | 题库走服务端接口不进包；静态资源极少，主包压力小，暂不需要分包 |

## 2. 技术选型

| 路线 | 做法 | 结果 |
| --- | --- | --- |
| **Taro 4 + React（选它）** | React 代码编译成小程序渲染层，路由/组件按小程序规范 | 与 web 同技术栈，心智与依赖复用最大化；京东维护、生态最大 |
| uni-app（Vue） | Vue 语法编译 | 与现有 React 栈割裂 |
| 原生 WXML 重写 | 微信原生语法 | 无框架借力，全部手写 |

复用与重写边界（包边界沿用全仓规则，`apps/miniprogram` 只准依赖 `@jev/contracts`、`@jev/i18n`，禁止 `@jev/database`、`@jev/jev`；`@jev/ui` 是 Radix/DOM 实现，同样不引）：

| 层 | 处理 |
| --- | --- |
| `packages/contracts`（Zod 契约） | 整体复用 |
| `packages/i18n`（1130 行纯 TS 文案） | 整体复用，语言状态 hook 重写（storage 换 Taro storage） |
| 认证 | 复用 App 版 Bearer 链路（`Authorization: Bearer` + `set-auth-token` 头），api client 重写为 `Taro.request` 适配 |
| 实时房间流 | WS 客户端适配 `Taro.connectSocket`（重连 + seq 补齐逻辑照抄 web 实现） |
| 单人本地存档 | web 存 IndexedDB；小程序换 Taro storage 重写 `local-store`（数据形状不变） |
| UI 组件 | 重写：从 `@jev/ui/styles.css` 平移设计变量（深海色系 / 16px / 44px / radius token）为全局 CSS 变量，组件（Button/Panel/Field/Dialog/徽标…）用 Taro 组件手写一套 |
| 页面 | 23 条路由逐页移植，路由改 Taro pages 配置；邀请链接形态换成小程序分享卡片 + 复制链接双通道 |

## 3. 整体架构

```mermaid
flowchart LR
  mp["小程序端 apps/miniprogram<br/>（Taro + React，重写界面层）"]
  web["网页端 apps/web"]
  app["Android 壳 apps/app"]
  api["apps/api（零改动）"]
  mp -- "HTTPS + Bearer 令牌<br/>WSS + ticket" --> api
  web -- "HTTPS + Cookie" --> api
  app -- "HTTPS + Bearer" --> api
```

后端增量：M6 微信支付 JSAPI 仍待小程序 AppID 就位后动工；微信登录已落地（见顶部 M2.6 记录：`POST /auth/wechat-mini/login` + `WECHAT_MINI_APPID/SECRET`）。

## 4. 里程碑

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| M0 骨架与适配层 | Taro 工程进 monorepo；api client（Bearer）；i18n/语言 hook；设计变量与基础 UI 件；路由表与首页静态 | `taro build weapp` 出包；微信开发者工具能打开渲染首页；typecheck 全绿 |
| M1 认证与账号 | ~~登录（密码+OTP）/找回密码~~ → 2026-10-27 换微信一键登录（M2.6 记录）；设置（昵称、语言、兑换码、隐私政策）/我的（账号卡、会员面板、多人历史） | 小程序内登录拿令牌、/me 与兑换全通 |
| M2 题库与单人 | 题库列表（难度/类别筛选、分页、排序）、单人游玩全流程（本地存档适配、匿名凭证、判定展示、切题/换题） | 小程序内完整玩一局单人 |
| M3 多人房间 | 会客厅（选题/开始）、房间实时流（WS 适配）、命令通道、大厅与公开房、邀请（分享卡片 + 复制链接） | 小程序与网页端同桌对局互发问答 |
| M4 社交 | 好友（搜索/申请/同意）、私聊（3s 轮询）、通知中心（10s 轮询）、铃铛 | 跨端好友互发私聊与通知 |
| M5 创作 | 作品列表、编辑器（含版本/审核反馈）、预览私测、提交 | 小程序投稿到审核流 |
| M6 支付与分享 | 会员面板展示 + 复制购买链接（赞助码兜底）；JSAPI 直付（Android）与微信登录为独立增量项 | 小程序内完成一次会员购买（引导路径） |
| M7 类目申报与提审 | 深度合成类目材料（MiniMax 备案 + 协议）、数据自检、提审与驳回应对 | 通过审核上架 |

每阶段收尾 `pnpm typecheck`；服务端不改，联调直接打生产接口（只读接口安全；写接口用测试账号）。

## 5. 需要用户准备的事（M1 前后就要用）

1. **注册小程序**：[微信公众平台](https://mp.weixin.qq.com) 用个体工商户主体注册，拿到 **AppID + AppSecret**（开发管理 → 开发设置）；AppID/AppSecret 配进服务端 `WECHAT_MINI_APPID` / `WECHAT_MINI_SECRET` 后小程序才能登录（开发期可先用测试号，但 code2session 要真实凭据）
2. **微信开发者工具**（Windows 稳定版）：真机预览与调试都靠它
3. 后台「开发管理 → 服务器域名」配置：request 合法域名 `https://sp.xiaobaozi.cn`、socket 合法域名 `wss://sp.xiaobaozi.cn`
4. M7 提审前：**MiniMax 的合作协议与算法备案截图**（MiniMax 开放平台可申请）+ 小程序 ICP 备案（注册流程自带）

## 6. 风险

| 风险 | 应对 |
| --- | --- |
| 内容审核拒审（恐怖灵异题材） | 预案见 §1；先全量上，驳回后按驳回意见收敛 |
| 深度合成类目材料不齐 | M7 才需要；期间用测试号/体验版开发不受影响 |
| Taro 版本升级破坏性变更 | 锁 minor 版本；升级单独提交 |
| WS 在小程序环境的连接数/后台断连限制 | 前台场景为主；复用 web 的指数退避 + seq 补齐 |
| iOS 端虚拟支付限制 | 支付引导到网页（§1） |

## 7. 内容尺度预案（若提审被驳回）

1. 第一档：小程序端隐藏「变格」分类入口（题库筛选与房间选题都不过滤服务端，只藏入口）
2. 第二档：服务端按渠道下发题库时剔除 flagged 题（需要加渠道字段，后端唯一改动）
3. 随时可用：小程序端只保留「创作 + 单人（自选题）」，多人房题库不变

## 8. 决策记录（2026-10-25 用户拍板）

1. 主体：个体工商户 + 微信商户号（已具备）
2. 路线：Taro 原生重写（web-view 套壳否决）
3. 范围：功能一比一，先全量内容提审，被拒再按 §7 收敛
4. 支付：先引导网页购买；JSAPI 直付为增量项
