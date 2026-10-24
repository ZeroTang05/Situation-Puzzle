# dl/ — App 安装包分发目录

这个目录挂在 web 容器里对外提供下载（`docker-compose.yml` 把它只读挂载到
`/usr/share/nginx/html/dl`，nginx 的 `/dl/` 路径按文件原样返回）。
官网下载页（`/app`）的下载按钮指向这里的文件。

## 放一个新版本（在服务器的仓库根目录）

```bash
# 1. 本机出正式包（需要 apps/app/android/keystore.properties，见 keystores/README.md）
#    产物：apps/app/android/app/build/outputs/apk/release/app-release.apk
# 2. 上传到服务器并就位（文件名固定，下载链接不变）
scp apps/app/android/app/build/outputs/apk/release/app-release.apk 服务器:仓库路径/dl/jev-turtle-soup.apk
# 3. 无需重启容器：只读挂载的目录内容变化即时生效
```

## 约定

- APK 文件不入 git（根 `.gitignore` 已排除 `dl/*.apk`），只存在服务器上；
  安装包由本机签名密钥签名（指纹与 App Links 认领文件对应，换密钥须同步更新
  `apps/web/public/.well-known/assetlinks.json` 并重新部署 web）。
- 固定下载地址：`https://sp.xiaobaozi.cn/dl/jev-turtle-soup.apk`；
  缺文件时 nginx 返回 404（不会落回网页）。
