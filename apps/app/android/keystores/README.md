# 签名密钥目录

这个目录存放 Android 签名密钥。**密钥文件（`.jks`）和口令文件（`keystore.properties`）都被
`.gitignore` 排除，永远不会进 git**——本目录里只有这份说明会入库。

## 现有密钥

| 文件 | 用途 | 别名（alias） |
| --- | --- | --- |
| `sp-upload.jks` | 「超好玩海龟汤」签名密钥（官网 APK 分发 + 上传 Google Play 的 upload key） | `sp-upload` |

配套的 `../keystore.properties`（与本目录同级）存放口令：

```properties
storeFile=keystores/sp-upload.jks
storePassword=<随机生成的 24 位口令>
keyAlias=sp-upload
keyPassword=<与 storePassword 相同，PKCS12 单口令>
```

`app/build.gradle` 只在这个文件存在时才启用 `signingConfigs.release`——
其他机器克隆仓库后没有它，依然可以构建（出未签名包）。

## ⚠️ 必须做的一次性备份

**丢了这个密钥（或口令），就永远无法再给同一个应用发更新**——用户手机上已装的 App
只认这把钥匙签的名，Play 商店也只认这把 upload key（除非走 Play 的「重置上传密钥」流程）。

生成后立刻：

1. 把 `sp-upload.jks` 复制到至少一个离线位置（U 盘 / 加密网盘 / 密码管理器附件）；
2. 把两个口令存进密码管理器；
3. 备份完成后在本文件勾选：`- [x] 已离线备份（日期：____）`

## 重新生成（仅供新项目参考，本项目不要执行）

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystores/sp-upload.jks -alias sp-upload \
  -keyalg RSA -keysize 2048 -validity 10950 \
  -dname "CN=Jev Turtle Soup, OU=Jev, O=xiaobaozi, C=CN"
```

## 查看 SHA-256 证书指纹（App Links 的 assetlinks.json 用）

```bash
keytool -list -v -keystores/sp-upload.jks | grep SHA256
```
