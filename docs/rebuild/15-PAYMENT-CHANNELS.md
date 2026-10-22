# 在线收款通道：微信支付 + 支付宝

> 面向运营方（配置凭据）与开发（接入说明）。
> 商户资质到位后，两条在线通道与已有的**赞助码**通道并存，互不影响。
> 赞助码通道的设计见 `14-REDEEM-CODE-CHANNEL.md`（零实名，仍然保留）。

## 一句话

订单与权益发放的逻辑**完全复用**（`orders.service.ts` 的 `confirmPaidTx`），
两条通道只差「怎么下单」和「怎么验签」。浏览器回跳不发放权益，
**权益只来自服务端收到并验签通过的支付通知**。

## 通道对比

| | 微信支付 Native | 支付宝 | 赞助码 |
| --- | --- | --- | --- |
| 通道标识 | `wechat_native` | `alipay` | `redeem_code` |
| 形态 | 扫码（`weixin://` 二维码） | 扫码（`qr.alipay.com`）或跳转页面 | 用户输码 |
| 结算 | 微信 | 支付宝 | 个人收款码 |
| 站内自动化 | 全自动（通知驱动） | 全自动（通知驱动） | 全自动（用户点兑换） |
| 能否同时开通 | 可以 | 可以 | 不受影响 |

---

## 微信支付：需要你申请 / 准备的东西

商户号你已经有了。**还差 5 样**，其中第 1 项最关键、最容易卡住。

### ① 绑定一个 AppID（最关键，也是唯一容易卡死的一步）

微信支付 Native 下单必须带 `appid`，且**该 appid 必须已与你的商户号关联**。

这是接口层级的硬要求，不是接入偏好。官方依据：

| 依据 | 原文 |
| --- | --- |
| Native 下单接口文档 | 请求体 `appid` **必填** string(32)【公众号ID】 |
| 同上的业务错误码 | `APPID_MCHID_NOT_MATCH`「AppID和mch_id不匹配 请确认AppID和mch_id是否匹配」 |
| Native 产品介绍 · 准入条件 | 支持的主体类型：个体工商户、企业、事业单位、政府机关、社会组织<br>支持的应用类型：**已认证的服务号**、已认证的政府或媒体类型的公众号、**已认证的小程序**、已认证的移动应用 |
| [管理商户号绑定的APPID账号](https://pay.weixin.qq.com/doc/v3/merchant/4013287010)（2025-06-27） | 「支持绑定的APPID类型：**已通过微信认证的服务号**、政府或媒体类公众号(原订阅号)、小程序、企业微信、移动应用」；「一个商户号最多可关联50个AppID账号」；「商户号与APPID建立关联关系后，**暂不支持解绑**」 |

> `APPID_MCHID_NOT_MATCH` 这条错误码本身就说明：填一个「存在但没绑定」的 AppID 过不了，
> 必须是**已关联**的。

| 路径 | 要求 | 说明 |
| --- | --- | --- |
| 公众号（服务号） | 已认证，主体为企业/个体户/其它组织 | 个人主体公众号做不了微信认证 → 拿不到可用 AppID |
| 小程序 | 已认证，主体为企业/个体户 | 认证费 ¥30（公众号 ¥300）；个人主体小程序能认证但**开不了微信支付** |
| 微信开放平台移动应用 | 企业，且应用需上架 | 一般不需要 |

#### 两条准入条件是「两个正交的轴」，必须同时满足

别把「已认证」读成对**主体**的要求——它修饰的是**应用**：

| 轴 | 回答的问题 | 取值 |
| --- | --- | --- |
| 主体类型 | **谁在收钱**（钱归谁） | 个体工商户、企业、事业单位、政府机关、社会组织（+ 小微商户） |
| 应用类型 | **哪个 AppID 承载这次支付** | 已认证的服务号 / 已认证的政府或媒体类公众号 / **已认证的小程序** / 已认证的移动应用 |

「已认证」是应用侧资质，个体工商户持营业执照**可以做**微信认证（个人主体不行）。
所以个体工商户拿一个已认证小程序或已认证服务号，就能同时满足两轴。

> **Native 支付不要求必须是服务号**——准入条件里明确包含「已认证的小程序」和「已认证的移动应用」。
> Native 下单只要 `appid` + `mchid`，不要 openid、不要授权目录，
> appid 在这里只是「支付身份标识 + 收款方呈现」。

#### 各主体权限对照（官方《各主体权限对照说明》原文）

| 主体 | JSAPI | 小程序 | APP | H5 | **Native** | 付款码 |
| --- | --- | --- | --- | --- | --- | --- |
| 企业 | 支持 | 支持 | 支持 | 支持 | **支持** | 支持 |
| **个体工商户** | 支持 | 支持 | 支持 | **不支持** | **支持** | 支持 |
| 事业单位 | 支持 | 支持 | 支持 | 支持 | **支持** | 支持 |
| 政府机关 | 支持 | 支持 | 支持 | 支持 | **支持** | 支持 |
| 社会组织 | 支持 | 支持 | 支持 | 支持 | **支持** | 支持 |
| 小微商户 | 支持 | 支持 | 不支持 | 不支持 | **支持** | 支持 |

个体工商户**唯一不支持的是 H5 支付**，Native 照常支持。

#### Native 与「浏览器网页」是什么关系

官方定位：**「提供商户在 PC 端网页浏览器中使用微信支付收款的能力」**。
「Native」指的是**付款动作发生在微信原生客户端里**，不是在浏览器网页里完成支付——
商家侧在 PC 网页展示二维码、付款侧在微信 App，这两件事不矛盾：

1. 商户后端调 `/v3/pay/transactions/native` → 拿 `code_url`（`weixin://` 协议链接）
2. 前端把 `code_url` 渲染成二维码
3. 用户用**微信「扫一扫」**扫描 → 进入微信支付确认页（可确认收款方与金额）
4. 点「立即支付」→ 验密（密码 / 指纹）
5. 支付成功页；账单在「微信支付 - 我的账单」里
6. 异步通知回调到商户后端，权益由**验签通过的回调**发放

与相邻产品的差别在「付款发生在哪」：

| 产品 | 商家侧 | 付款侧 |
| --- | --- | --- |
| **Native** | PC 网页（只负责亮一张码） | **微信 App 扫一扫**，不在你的网页里 |
| 电脑网站支付 / JSAPI | PC 网页 | 微信**内置浏览器**里打开你的网页 |
| H5 支付 | 手机网页 | 手机浏览器（非微信内）跳起微信 |
| APP 支付 | 原生 App | App 内 SDK 唤起微信支付 |

> ⚠️ 官方硬限制：「**不支持通过相册识别或长按识别二维码的方式完成支付**」。
> 所以「把二维码存到相册再识图」这条路在 Native 下走不通。

#### 本项目是移动优先网页，Native 在手机端有先天短板

当前适配器只实现了 Native（`wechat-pay.adapter.ts` 的 `/v3/pay/transactions/native`，
`payUrl` 恒为 `null`，只有 `qrContent` 二维码）。但本项目是**移动优先**的：

- 手机上打开「我的 - 赞助」页 → 二维码就在**自己屏幕上** → 需要**另一台设备**才能扫；
- 官方又禁止相册识别 / 长按识别 → 「存图再扫」也不通；
- 唯一不适配的是：**个体工商户不支持 H5 支付**，而 H5 正是手机浏览器跳起微信的标准方案。

按主体与端分开选型的结论：

| 场景 | 可用方案 | 说明 |
| --- | --- | --- |
| **PC 浏览器** | ✅ **Native 扫码**（当前实现，零改动） | 桌面端体验最顺，个体工商户支持 |
| 手机微信内置浏览器 | JSAPI 支付 | 需公众号 AppID + 用户 openid（网页 OAuth 换取）+ 支付授权目录 |
| 手机非微信浏览器 | ❌ 不可用 | 个体工商户无 H5 权限；小程序有独立支付体系但不是网页 |
| Android 壳（`apps/app`） | APP 支付 | 需开放平台移动应用 + 已认证 + 应用上架；个体工商户支持 |

短期不动的建议：前端在**窄屏**时把二维码提示改成明确的「请用电脑扫码支付」，
避免用户在手机上对着自己的屏幕扫半天。JSAPI 属于新增适配器分支（要 openid 链路），
等确定要做移动端收款再开工。

**两层主体都要合法**：支付主体（商户号）不能是个人，最小是「小微」或「个体工商户」；
应用侧必须是「已认证」的应用。

操作路径（**两步，缺一不可**）：

1. 微信支付商户平台 → **产品中心 → AppID 账号管理 → 关联 AppID** →
   填入 AppID，签《微信支付商户号与APPID授权协议》提交。
   一个商户号最多关联 50 个 AppID；AppID 主体与商户号主体不一致时还要签
   《微信支付联合营运承诺函》，审核 1–3 个工作日。
2. **回到公众号/小程序后台** → 微信支付 → 商户号管理 → 找到申请记录 →
   **管理员扫码确认授权**。
   待授权状态**超 7 日自动失效且不可恢复**，所以提交后要马上去确认。

> **小微商户（服务商模式）例外**：个人没有营业执照时，微信支付的正路是找服务商做小微商户进件
> （身份证 + 结算银行卡，5 分钟审核）。但小微商户属于**服务商模式**，
> 而本项目的适配器是**直连商户**版本（`/v3/pay/transactions/native` + `mchid`），
> **不适用**——真要走这条路需要另加一版服务商适配器。

> 拿不到 AppID 就没法用 Native 通道。此时先用支付宝通道收款
> （支付宝的 APPID 是开放平台自助创建的应用 ID，不需要公众号、不需要微信侧资质）。

#### 唯一的例外：服务商模式下 `sub_appid` 是选填的

如果用户问「到底能不能不填 AppID」，官方口径是**分两种接入模式**：

| 接入模式 | 下单接口 | AppID 字段 | 能否不绑 AppID |
| --- | --- | --- | --- |
| **普通商户（直连）** ← 本项目当前实现 | `/v3/pay/transactions/native` | `appid` **必填** | **不能**，必须关联一个已认证 AppID |
| **服务商模式** | `/v3/pay/partner/transactions/native` | `sp_appid` 必填（服务商自己的）<br>`sub_appid` **选填**（子商户的） | **能**，子商户可以不绑 AppID |

服务商 Native 下单参数（官方文档 [Native下单·合作伙伴文档中心](https://pay.wechatpay.cn/doc/v3/partner/4012523551)）：

- `sp_appid` **必填** string(32)【服务商公众号ID】——服务商自己的 AppID，与 `sp_mchid` 有绑定关系；
- `sub_appid` **选填** string(32)【子商户/二级商户应用ID】；
- `sub_mchid` **必填** string(32)【子商户号】。

服务商进件时 `web_appid` 同样是**选填**：填了就由系统发起特约商户号与该 AppID 的绑定
（即配置为 `sub_appid`），「服务商随后**可在发起支付时选择传入**该 AppID」——即不传也能下单。

> 所以「不填 AppID」在微信支付里**只有服务商模式这一条路**：
> 代价是多一层服务商（服务商有 0.6% 左右技术服务费），且本项目要另写一版服务商适配器
> （签名要带 `sp_mchid`/`sub_mchid`，证书与密钥换成服务商与子商户两套）。
> 直连模式下没有绕过办法——`APPID_MCHID_NOT_MATCH` 会直接打回。

### ② 商户 API 证书（商户私钥 + 序列号）

路径：微信支付商户平台 → **账户中心 → API 密钥 → 申请 API 证书**。

申请后会下载一个 zip，里面有两个文件：

| 文件 | 用途 | 填到哪 |
| --- | --- | --- |
| `apiclient_key.pem` | 商户 API 私钥，用来给请求签名 | `WECHAT_PAY_PRIVATE_KEY_PATH` |
| `apiclient_cert.pem` | 商户证书（本项目只验平台公钥，可不放服务器） | — |

同时页面会显示一个**证书序列号**（形如 `5c1f1a...` 十六进制），填到 `WECHAT_PAY_SERIAL`。

### ③ APIv3 密钥

路径：商户平台 → **账户中心 → API 密钥 → 设置 APIv3 密钥**。

自己设置的 32 字节字符串（字母数字，**长度必须正好 32**），填到 `WECHAT_PAY_API_V3_KEY`。
它同时用于：回调报文的 AES-256-GCM 解密。**设置后不可找回，务必自己存好。**

### ④ 微信支付平台公钥

路径：商户平台 → **账户中心 → 平台证书 → 下载「微信支付公钥」**（`pub_key.pem`）。

用于**验证回调签名**（通知里的 `Wechatpay-Signature` 就是用它验的）。
把公钥文件放到服务器，填 `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH`。

> 微信现在同时提供「平台证书」和「微信支付公钥」两种验签材料，本项目用**公钥**这一种。
> 拿「平台证书」也可以——`createPublicKey` 能直接从证书 PEM 里取出公钥。

### ⑤ 异步通知地址

必须是**公网可达、已备案域名**的 https 地址：

```
https://sp.xiaobaozi.cn/api/v1/payments/wechat_native/notify
```

填到 `WECHAT_PAY_NOTIFY_URL`。留空会退化成用 `PUBLIC_BASE_URL` 拼，但那个值通常是
前端地址（`http://localhost:5173`），**回调打不通**——所以务必显式配置。

### 微信支付配置汇总

```bash
WECHAT_PAY_MCHID=你的商户号
WECHAT_PAY_APPID=上面关联的 AppID
WECHAT_PAY_SERIAL=申请 API 证书时页面显示的证书序列号
WECHAT_PAY_PRIVATE_KEY_PATH=/run/secrets/wechat/apiclient_key.pem
WECHAT_PAY_API_V3_KEY=你设置的32位APIv3密钥
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH=/run/secrets/wechat/pub_key.pem
WECHAT_PAY_NOTIFY_URL=https://sp.xiaobaozi.cn/api/v1/payments/wechat_native/notify
```

**七个全配齐，通道才会打开。** `createWechatAdapter` 少任意一项就返回 `null`，
前台显示「支付通道开通中」，下单直接报 `PAYMENT_CHANNEL_UNAVAILABLE`。

### 商户平台「产品中心 → 支付配置」怎么填

| 页面上的项 | 填什么 | 说明 |
| --- | --- | --- |
| **Native支付 → Native支付回调链接** | `https://sp.xiaobaozi.cn/api/v1/payments/wechat_native/notify` | 就是 `WECHAT_PAY_NOTIFY_URL` |
| **JSAPI支付 → 支付授权目录** | **不用填** | 支付授权目录是 JSAPI（公众号内唤起支付）专用的 |

本项目走的是 **Native 扫码**（`/v3/pay/transactions/native`），和 JSAPI 是两个不同产品：
JSAPI 需要公众号 AppID + 用户 openid + 支付授权目录，我们一个都不需要。
填了授权目录也不会生效。

下单请求里的 `notify_url` 由代码显式传（`wechat-pay.adapter.ts:87`），
值取自 `WECHAT_PAY_NOTIFY_URL`；商户平台这一栏填成同一个地址，两边一致最稳。

> **开通 Native 支付时的经营场景**：在商户平台申请开通时选「PC 网站」场景，
> 需要**已备案的域名，且备案主体与商户号主体一致**。域名没备案或主体对不上会驳回。
> 回调地址 `sp.xiaobaozi.cn` 必须落在已备案域名下。

> **容易填错的两个「序列号」**：
> - `WECHAT_PAY_SERIAL` = **商户 API 证书**的序列号（申请 API 证书时页面显示的那串）
> - `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH` = **微信支付公钥** `pub_key.pem`（验回调签名用）
>
> 回调通知头里的 `Wechatpay-Serial` 传的是微信支付**公钥 ID**，不是商户证书序列号——
> 本项目用公钥本身验签，所以只要公钥文件放对就不用管这个 ID。
>
> **不要用商户自己的公钥验回调**：商户公钥是给平台验你签名的，
> 验回调要用平台公钥（`pub_key.pem`）。用错了会一直报「回调验签失败」。

---

## 支付宝：需要你申请 / 准备的东西

### ① 开放平台账号 + 应用（拿 APPID）

路径：支付宝开放平台 → **控制台 → 我的应用 → 创建应用**。

- 应用类型：自研服务
- 拿到 **APPID**（形如 `2021xxxxxxxxxxxxxx`）→ `ALIPAY_APP_ID`

### ② 签约产品

在开放平台 → **产品 → 签约产品**里签。本项目支持两种，用哪个由 `ALIPAY_PRODUCT` 决定：

| 产品 | 方法 | 场景 | 前端体验 |
| --- | --- | --- | --- |
| **当面付** | `alipay.trade.precreate` | 线下/PC 扫码 | 渲染二维码，手机扫 |
| **电脑网站支付** | `alipay.trade.page.pay` | PC 网页 | 跳转到支付宝页面付款 |

> 扫码是**当面付**，跳转是**电脑网站支付**——两个不是同一个产品，要分别签。
>
> **本项目已签：当面付（`precreate`）**，即 `ALIPAY_PRODUCT=precreate`（也是代码默认值）。
> 前台与微信 Native 同构：站内渲染二维码，手机扫。
> 将来若要加签「电脑网站支付」，把环境变量改成 `ALIPAY_PRODUCT=page` 即可，代码不用动。

### ③ 密钥配置（两种模式，选一种）

#### 公钥模式（推荐先用这个）

1. **自己生成应用私钥**（RSA2，2048 或 4096 位），格式 PKCS8：

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out app_private_key.pem
   openssl pkey -in app_private_key.pem -pubout -out app_public_key.pem
   ```

2. 把 `app_public_key.pem` 的**内容**（去掉 `-----BEGIN/END PUBLIC KEY-----` 那两行，
   只留中间那行 base64）粘贴到开放平台 → 应用 → **开发设置 → 接口加签方式**，
   选「公钥」，并设置 **RSA2**。

3. 开放平台 → 应用 → 开发设置 → **接口加签方式 → 查看支付宝公钥**，
   复制那串 base64，保存成 PEM 文件：

   ```bash
   # 把公钥内容写成 PEM（含 BEGIN/END 头尾）
   cat > alipay_public_key.pem <<'EOF'
   -----BEGIN PUBLIC KEY-----
   MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
   -----END PUBLIC KEY-----
   EOF
   ```

   → `ALIPAY_PUBLIC_KEY_PATH`

4. 应用私钥文件 → `ALIPAY_PRIVATE_KEY_PATH`

#### 证书模式（开放平台强制要求时用）

需要三个证书 + 三个序列号：

| 文件 | 从哪来 | 填到哪 |
| --- | --- | --- |
| 应用公钥证书 `appCertPublicKey.crt` | 开放平台下载 | 放服务器（用于算 SN） |
| 支付宝公钥证书 `alipayCertPublicKey_RSA2.crt` | 开放平台下载 | → `ALIPAY_PUBLIC_KEY_PATH`（本项目能直接从证书里取公钥） |
| 支付宝根证书 `alipayRootCert.crt` | 开放平台下载 | 放服务器（用于算 SN） |
| 应用私钥 `appPrivateKey.pem` | 自己生成 | → `ALIPAY_PRIVATE_KEY_PATH` |

三个证书序列号用这个命令算：

```bash
pnpm --dir apps/api exec tsx src/cli/pay-cert-sn.ts \
  alipayCertPublicKey_RSA2.crt appCertPublicKey.crt alipayRootCert.crt
```

分别填到 `ALIPAY_CERT_SN` / `ALIPAY_APP_CERT_SN` / `ALIPAY_ROOT_CERT_SN`
（开放平台控制台也会直接显示这三个 SN，填哪个都行）。

### ④ 商户 PID

开放平台 → **账号中心 → 开发者信息 → PID**（形如 `2088xxxxxxxxxxxx`）→ `ALIPAY_SELLER_ID`。

用于校验支付通知里的 `seller_id` 是不是你自己（防止别人伪造通知）。

### ⑤ 异步通知地址

```
https://sp.xiaobaozi.cn/api/v1/payments/alipay/notify
```

填到 `ALIPAY_NOTIFY_URL`。同样必须是公网可达的 https 域名。

### 支付宝配置汇总

```bash
ALIPAY_APP_ID=你的APPID
ALIPAY_PRIVATE_KEY_PATH=/run/secrets/alipay/app_private_key.pem
ALIPAY_PUBLIC_KEY_PATH=/run/secrets/alipay/alipay_public_key.pem
ALIPAY_NOTIFY_URL=https://sp.xiaobaozi.cn/api/v1/payments/alipay/notify
ALIPAY_PRODUCT=precreate
ALIPAY_SELLER_ID=2088xxxxxxxxxxxx
# 证书模式才需要：
# ALIPAY_CERT_SN=
# ALIPAY_APP_CERT_SN=
# ALIPAY_ROOT_CERT_SN=
```

### 沙箱（强烈建议先在沙箱跑通）

支付宝有沙箱环境，不用真掏钱：

- 沙箱网关：`https://openapi.alipaydev.com/gateway.do` → `ALIPAY_GATEWAY`
- 沙箱有**独立的 APPID、支付宝公钥、账号**，在开放平台 → 沙箱环境里拿
- 沙箱账号里有虚拟余额，可以真实走完「下单 → 扫码 → 通知 → 权益到账」

沙箱跑通后，把配置切回生产网关、换生产 APPID 与公钥，再做一笔**真实小额支付**（1 元）验证。

---

## 服务器上怎么放密钥

密钥**不要进镜像、不要进仓库**。用 docker secret 或 volume 挂进容器：

```yaml
# docker-compose.yml（本项目实际配置）
services:
  api:
    volumes:
      - ${PAYMENT_SECRETS_DIR:-/root/.pem}:/run/secrets/payment:ro
```

容器里 `WECHAT_PAY_PRIVATE_KEY_PATH=/run/secrets/payment/wechat_pay/apiclient_key.pem`。

本地开发时路径直接写绝对路径（如 `E:/keys/apiclient_key.pem`）。

### 路径必须写「容器内绝对路径」

三条硬规则，违反任何一条都会让通道**静默**变成「支付通道开通中」：

1. **不能写宿主机路径**。`.env` 通过 `env_file` 注入容器，容器**不继承宿主文件系统**。
   写 `/root/.pem/...` 会在容器里变成「该路径不存在」。
2. **不能写相对路径**。相对路径相对进程的 cwd 解析，而容器 cwd 随启动方式变
   （实测 api 容器是 `/app/apps/api`），迟早失效。
3. **要用容器内绝对路径**（`/run/secrets/payment/...`），且与 volume 的 `target` 对得上。

> 为什么是「静默」失败而不是启动报错：`readFileSync` 在 `createWechatAdapter()` 里调用，
> 而该函数**不是只在启动时调一次**——`orders.service.ts:36` 每次下单、每次查单、
> 每次算 `availableChannels()` 都会重建适配器。路径不对 = 每次请求抛 ENOENT，
> 被 `GlobalExceptionFilter` 兜成 500，前台只看到「支付通道开通中」，
> 从报错里很难看出是路径问题。
>
> 验证方法（比读代码可靠）：在容器里直接构造适配器，
> 看它是否返回非 null。
> ```bash
> docker exec situation-puzzle-api-1 sh -c \
>   'cd /app && pnpm --dir apps/api exec tsx -e "
>     import { createWechatAdapter } from \"./src/billing/wechat-pay.adapter.js\";
>     console.log(createWechatAdapter(process.env) !== null);"'
> ```

### 私钥权限

宿主机上 `chmod 600` 商户私钥；容器内以只读方式挂载（`:ro`）。

---

## 代码落点

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/billing/pay-adapter.ts` | 两通道共享的接口契约（`PayChannel` / `PayAdapter`） |
| `apps/api/src/billing/wechat-pay.adapter.ts` | 微信 v3：请求签名、回调验签解密、查单、关单、退款 |
| `apps/api/src/billing/alipay-pay.adapter.ts` | 支付宝：RSA2 签名、预下单/页面支付、查单、关单、退款、通知验签 |
| `apps/api/src/billing/orders.service.ts` | 按通道分派；下单、核销、关单、通知幂等 |
| `apps/api/src/billing/billing.controller.ts` | `POST /orders`（带 channel）、`POST /payments/:channel/notify` |
| `apps/web/src/me/sponsor-panel.tsx` | 通道选择、二维码渲染、订单状态轮询 |
| `apps/web/src/me/qr-code.tsx` | 二维码生成（`qrcode-generator` → SVG → data URL） |

### 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/payment-channels` | 各通道是否可用（前端据此显示入口） |
| `POST /api/v1/orders` | 下单，body `{ productVersionId, channel }` |
| `GET /api/v1/orders/:id` | 查订单状态（前端轮询用） |
| `POST /api/v1/payments/{channel}/notify` | 支付通知（无会话，验签在服务端） |

### 退款只在后台，玩家端没有退款入口

退款是**运营动作**，不是用户自助功能：

| 位置 | 入口 |
| --- | --- |
| 管理后台 | `POST /admin/orders/:id/refund`（`admin` / `finance` 角色，必填理由）→ 后台订单列表「审核退款」按钮 |
| 玩家端（`apps/web`） | **没有**退款入口，也不要加 |

三种终态不同，后台会按实际结果分别提示：

| `channelRefund` | 含义 | 授权终态 |
| --- | --- | --- |
| `done` | 线上通道退款成功 | `revoked` |
| `not_applicable` | 赞助码等线下收款通道，没有线上退款步骤，钱由运营方线下退 | `revoked`（站内直接撤销） |
| `failed` | 通道退款失败，或**在线通道凭据缺失导致调不到退款接口** | `frozen`（保持冻结，订单留 `refund_pending`，等人工跟进） |

> 第三种最容易出错：在线通道如果因为凭据被移除而拿不到适配器，钱**还没退**，
> 绝不能当成「无线上退款步骤」把权益撤了。判断依据是**通道类型**，不是「适配器在不在」。
> 两条分支都有集成测试钉住（`payment-channels.integration.test.ts` /
> `redeem-codes.integration.test.ts`）。

### 两通道的协议差异（已在适配器里抹平）

| | 微信 v3 | 支付宝 |
| --- | --- | --- |
| 通知内容类型 | JSON + AES-256-GCM 加密 | `x-www-form-urlencoded` 表单 |
| 通知验签 | 平台公钥验签 + APIv3 密钥解密 | 支付宝公钥验签（明文表单） |
| 成功应答 | JSON `{"code":"SUCCESS"}` | 纯文本 `success` |
| 金额单位 | 分 | **元**（适配器内部换算） |
| 同步应答验签 | 不适用（HTTP 状态码即结果） | **必须验签**（应答里的 `qr_code` 直接决定用户付给谁） |

---

## 上线前检查清单

- [ ] 商户资质已审核通过，两条通道的产品都已签约
- [ ] 回调地址公网可达（`curl -X POST <notify_url>` 能收到请求；微信要带签名头，支付宝要带签名）
- [ ] 密钥文件权限收紧（容器内只读、宿主机 `chmod 600`）
- [ ] **`*_KEY_PATH` 写的是容器内绝对路径**（不是宿主机路径、不是相对路径），
      且在容器内能真正读出来（见「路径必须写「容器内绝对路径」」里的验证命令）
- [ ] 沙箱（支付宝）或真实小额支付（微信）走完一次完整链路
- [ ] 收到真实通知后 `payment_notifications` 有记录、`orders.status` 变 `paid`、`sponsor_grants` 有授权
- [ ] 退款链路验证过一次
- [ ] `pnpm typecheck` 与 `pnpm test` 全绿

## 踩坑记录

- **微信回调验签的公钥别用商户自己的**。商户公钥是给平台验你签名的，
  验回调要用**平台公钥**（`pub_key.pem`）。用错了会一直报「回调验签失败」。
- **APIv3 密钥必须正好 32 字节**，少一位启动就报错。
- **支付宝的金额单位是元**，站内一律用分（`amountMinor`），换算在适配器里，别在业务层写。
- **支付宝同步应答必须验签**。不验的话拿到被篡改的 `qr_code` 就会把用户导向别人的收款码。
- **支付宝通知是表单不是 JSON**。`bootstrap.ts` 用 `express.raw({ type: '*/*' })` 挂了
  `/api/v1/payments` 前缀，所以支付宝的表单体能原样拿到，适配器里用 `node:querystring` 解析。
- **微信通知是 JSON——所以 `express.raw` 必须挂在 `express.json` 之前**（曾真实发生过，勿改顺序）。
  `express.json()` 无条件匹配 `application/json` 并**消费掉请求流**；
  排在它后面时 `express.raw` 拿到的是已解析的对象而不是原始字节，
  验签必然失败 → 通知被当作「验签失败」丢弃 → **用户付了钱永远拿不到权益**。
  支付宝因为是表单（不匹配 `express.json`）所以侥幸没事——**这个坑只在微信通道暴露**，
  只测过支付宝会漏掉。
  回归测试见 `apps/api/src/billing/payment-notify-body.test.ts`（对真实 express 断言 body 仍是 Buffer）。
  > 为什么集成测试查不出：集成测试直调 `service.handleNotification` 并手工构造 Buffer，
  > 绕过了 express 解析层。与当初 `notify` 漏标 `@Public()` 被守卫 401 是同一类盲区。
- **同一用户换通道下单会拿到两笔订单**。`createOrder` 复用 pending 订单时按
  「用户 + 商品 + 通道」匹配，跨通道不复用。
- **通知金额必须与订单金额一致**，不一致时服务端拒绝入账（防篡改）。
