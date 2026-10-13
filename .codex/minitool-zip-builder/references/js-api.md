# 小工具 JS API 本地参考

> 本文是 2026-09-23 的本地快照，按 `docs/index.html` 的 JS API 章节复刻，保留参数表、约束与示例。实现时应优先获取[小工具在线文档](https://miniapp-sandbox.xiaohongshu.com/minitool/doc)；仅当远程文档无法获取时，才以本文作为 API 契约参考。

容器自动注入 `window.xhs`，无需在包内引入 SDK。端能力从 `window.xhs.miniTool` 调用。

## 调用约定

- 传入 `success`、`fail`、`complete` 任一回调时，API 返回 `undefined`；均不传时返回 Promise。
- 成功结果包含 `errMsg: "<api>:ok"` 与对应业务字段；失败结果包含 `errMsg: "<api>:fail ..."` 与可选 `errCode`。
- 调用前检查 `window.xhs`、`window.xhs.miniTool` 和具体方法是否存在，并为低版本或未注入环境提供降级处理。
- 只调用本文列出的 API，不直接调用原生 bridge。

```js
const miniTool = window.xhs && window.xhs.miniTool;

if (miniTool && typeof miniTool.saveImageToPhotosAlbum === "function") {
  try {
    await miniTool.saveImageToPhotosAlbum({ filePath });
  } catch (error) {
    console.log(error.errMsg, error.errCode);
  }
}
```

## API 一览

| API | 用途 | 最低客户端版本 |
| --- | --- | --- |
| `postNote` | 打开笔记发布页并携带内容和媒体 | — |
| `saveImageToPhotosAlbum` | 保存图片至系统相册 | — |
| `writeTempFile` | 将 base64 写入临时文件 | — |
| `getLaunchOptions` / `window.xhs.launchOptions` | 获取启动参数和环境信息 | — |
| `setStorage` / `getStorage` / `getStorageInfo` / `removeStorage` / `clearStorage` | 小工具本地缓存 | 9.46 |
| `saveFile` / `writeFile` / `appendFile` / `readFile` / `readDir` / `statFile` / `unlink` / `mkdir` / `getFileStorageInfo` | 本地文件系统 | 9.49 |
| `interactionOpenApi` | 唤起评论区并携带评论草稿 | 9.49 |

图片、视频与封面等媒体字段只接受 `data:` base64 或本地文件路径；容器不联网，网络地址不可用。体积较大的 base64 建议先用 `writeTempFile` 换成 `filePath` 再传递。

## 启动参数与版本判断

同步读取启动参数：

```js
const launchOptions = window.xhs && window.xhs.launchOptions;
const userDataPath = launchOptions && launchOptions.miniToolEnv && launchOptions.miniToolEnv.userDataPath;
```

同步值不可用时，检查 `getLaunchOptions` 存在后异步读取：

```js
const miniTool = window.xhs && window.xhs.miniTool;
const launchOptions = await miniTool.getLaunchOptions();
const { userDataPath } = launchOptions.miniToolEnv;
```

`miniToolEnv.userDataPath` 是持久文件目录根路径。仅在它之后拼接相对路径；不要硬编码、解析或改写端上返回的文件句柄。

`miniToolEnv.buildVersion` 的末三位为编译序号，判断客户端版本时忽略。例如 `9462004` 代表客户端 `9.46.2`，用于版本比较的值为 `9462`：

```js
function getClientVersion(buildVersion) {
  return Math.floor((Number(buildVersion) || 0) / 1000);
}

function isClientVersionAtLeast(buildVersion, minimumClientVersion) {
  return getClientVersion(buildVersion) >= minimumClientVersion;
}
```

完整的同步优先、异步回退读取方式：

```js
function readBuildVersion(launchOptions) {
  const miniToolEnv = launchOptions && launchOptions.miniToolEnv;
  return Number(miniToolEnv && miniToolEnv.buildVersion) || 0;
}

async function getBuildVersion() {
  const xhs = window.xhs;
  const syncBuildVersion = readBuildVersion(xhs && xhs.launchOptions);
  if (syncBuildVersion) return syncBuildVersion;

  const miniTool = xhs && xhs.miniTool;
  if (!miniTool || typeof miniTool.getLaunchOptions !== "function") return 0;

  try {
    return readBuildVersion(await miniTool.getLaunchOptions());
  } catch (error) {
    return 0;
  }
}
```

## postNote

打开笔记发布页。`mediaInfo` 必传，`image_resources`、`video_resources`、`live_photo_sources` 至少提供一种。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 标题，最长 20 字 |
| `content` | string | 正文，最长 1000 字 |
| `pageType` | string | `video_publish`、`photo_publish` 或 `slides_edit`（9.43+） |
| `mediaInfo.image_resources` | `{ url }[]` | 图片，1–18 张；`url` 为 data URI 或本地路径 |
| `mediaInfo.video_resources` | `{ video_url, cover_url? }` | 单个视频及可选封面 |
| `mediaInfo.live_photo_sources` | `{ url, video_url }[]` | 实况照片，1–18 组（9.43+） |

```js
await window.xhs.miniTool.postNote({
  title: "我的作品",
  content: "用小工具生成的",
  pageType: "photo_publish",
  mediaInfo: {
    image_resources: [{ url: "data:image/png;base64,..." }],
  },
});
```

```js
// 视频笔记
await window.xhs.miniTool.postNote({
  pageType: "video_publish",
  mediaInfo: {
    video_resources: { video_url: videoPath, cover_url: coverPath },
  },
});

// 实况笔记（客户端 9.43+）
await window.xhs.miniTool.postNote({
  pageType: "slides_edit",
  mediaInfo: {
    live_photo_sources: [{ url: coverPath, video_url: videoPath }],
  },
});
```

成功回调只表示发布页已被唤起并由用户点击发布，不代表笔记最终审核通过；不要据此做强一致业务状态。

## saveImageToPhotosAlbum

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `filePath` | string | 是 | 本地图片：`data:` base64 或 `writeTempFile` 返回的路径；不支持 `http(s)://` 网络地址 |

```js
const dataUrl = canvas.toDataURL("image/png");
await window.xhs.miniTool.saveImageToPhotosAlbum({ filePath: dataUrl });
```

应由用户点击等主动操作触发；首次调用可能请求相册权限。大图建议先通过 `writeTempFile` 落成文件，再保存至相册。

## writeTempFile

将 Canvas 或选图结果等 base64 数据写为临时文件：

```js
const { filePath } = await window.xhs.miniTool.writeTempFile({
  data: canvas.toDataURL("image/png"),
});

await window.xhs.miniTool.saveImageToPhotosAlbum({ filePath });
await window.xhs.miniTool.postNote({
  mediaInfo: { image_resources: [{ url: filePath }] },
});
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | string | 必填，base64 数据；支持带 `data:` 前缀的 data URI |
| `filePath` | string | 成功返回的临时文件路径 |

临时文件应即用即弃，不可作为长期持久化路径。支持常见图片与视频类型：png、jpeg、webp、gif、mp4。

## Storage 本地缓存

Storage API 在客户端 9.46+ 可用。`data` 只支持 JSON 字符串；对象或数组需要先序列化，读取后再解析。

| API | 参数 | 结果 / 说明 |
| --- | --- | --- |
| `setStorage` | `key: string`、`data: string`、`encrypt?: boolean` | 写入或覆盖缓存 |
| `getStorage` | `key: string`、`encrypt?: boolean` | 返回 `{ data }`；`encrypt` 与写入时一致 |
| `getStorageInfo` | 无业务参数 | 返回 `{ keys, currentSize, limitSize }`，单位 KB |
| `removeStorage` | `key: string` | 删除指定缓存 |
| `clearStorage` | 无业务参数 | 清空当前小工具缓存 |

单个 key 最大 1MB，当前小工具总缓存最大 10MB；`encrypt` 默认 `false`。

以下封装会在 9.46+ 使用 Storage，并在低版本回退到浏览器存储；调用方必须处理其返回的 `false`，不能假设数据已成功持久化：

```js
const STORAGE_MIN_CLIENT_VERSION = 9460;

async function setLocalData(key, data) {
  let serializedData;
  try {
    serializedData = JSON.stringify(data);
  } catch (error) {
    return false;
  }
  if (typeof serializedData !== "string") return false;

  const buildVersion = await getBuildVersion();
  const miniTool = window.xhs && window.xhs.miniTool;

  if (
    isClientVersionAtLeast(buildVersion, STORAGE_MIN_CLIENT_VERSION) &&
    miniTool &&
    typeof miniTool.setStorage === "function"
  ) {
    try {
      await miniTool.setStorage({ key, data: serializedData });
      return true;
    } catch (error) {
      return false;
    }
  }

  try {
    localStorage.setItem(key, serializedData);
    return true;
  } catch (error) {
    return false;
  }
}
```

```js
await window.xhs.miniTool.setStorage({
  key: "profile",
  data: JSON.stringify({ nickname: "小红薯" }),
});

const { data } = await window.xhs.miniTool.getStorage({ key: "profile" });
const profile = data === null ? null : JSON.parse(data);
```

低版本可以按需降级到浏览器存储，但必须处理读写失败，并容忍数据丢失或被清理。

## 文件系统

文件系统 API 在客户端 9.49+ 可用。文件和二进制数据使用文件系统保存，目录根路径来自 `miniToolEnv.userDataPath`。

| API | 参数 | 结果 / 说明 |
| --- | --- | --- |
| `saveFile` | `tempFilePath: string`、`filePath?: string \| null` | 将临时文件移动至持久目录，返回 `{ savedFilePath }` |
| `writeFile` | `filePath`、`data`、`encoding: "utf8" \| "base64"` | 覆盖写入，返回 `{ writtenBytes }` |
| `appendFile` | `filePath`、`data`、`encoding: "utf8" \| "base64"` | 追加写入，返回 `{ writtenBytes }` |
| `readFile` | `filePath`、`encoding`、`position?`、`length?` | 返回 `{ data, bytesRead, eof }` |
| `readDir` | `dirPath` | 返回 `{ files, truncated }` |
| `statFile` | `filePath` | 返回 `{ size, lastModified, isDir }` |
| `unlink` | `filePath` | 删除持久目录中的文件 |
| `mkdir` | `dirPath`、`recursive?` | 创建持久目录 |
| `getFileStorageInfo` | 无业务参数 | 返回 `{ usedBytes, limitBytes, fileCount, tmpUsedBytes, writeChunkMaxBytes, readChunkMaxBytes }` |

```js
const options = await window.xhs.miniTool.getLaunchOptions();
const filePath = options.miniToolEnv.userDataPath + "/drafts/note.json";

await window.xhs.miniTool.writeFile({
  filePath,
  data: JSON.stringify({ title: "草稿" }),
  encoding: "utf8",
});

const { data } = await window.xhs.miniTool.readFile({
  filePath,
  encoding: "utf8",
});
```

- `writeFile` 为覆盖写，`appendFile` 为追加写。写大文件时，第一片使用 `writeFile`，后续片串行使用 `appendFile`。
- 分片大小以 `getFileStorageInfo` 返回的 `writeChunkMaxBytes` 和 `readChunkMaxBytes` 为准，不要硬编码。
- 渲染图片或视频时直接使用文件句柄作为 `img.src`、`video.src` 或 CSS 资源；需要字节时才使用 `readFile`。
- `usr` 是本地工作区，不是备份空间。卸载、清数据或包清理后可能丢失，重要数据应可重建或由用户导出。

## interactionOpenApi 发布评论

评论区能力在客户端 9.49+ 可用，应由用户点击等主动操作触发。调用后容器会统一关闭小工具，再拉起评论区。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `payload` | object | 必填，评论草稿；字段由评论侧定义 |
| `payload.action` | string | 发布评论时使用 `post_comment` |
| `payload.content` | string | 可选，评论文本 |
| `payload.media_bean` | array | 可选，有序图片列表；媒体路径使用本地文件句柄 |
| `payload.miniToolSnapshotInfo` | string | 可选，小工具附加状态 JSON 字符串；最大 2KB，超限无效 |
| `saveToAlbum` | boolean | 可选，是否将图片同步保存到相册；默认 `true` |

```js
const result = await window.xhs.miniTool.interactionOpenApi({
  payload: {
    action: "post_comment",
    content: "快来和我 PK！",
    media_bean: [{
      media_type: "image",
      cover_image_url: imageFilePath,
    }],
    miniToolSnapshotInfo: JSON.stringify({ page: "result" }),
  },
  saveToAlbum: true,
});

// { routed, savedToAlbum, albumFailReason? }
```

- 评论文本和图片均可不传，仍可唤起评论区。
- 目前仅支持图片：`{ media_type: "image", cover_image_url }`；不支持视频或实况图。
- 媒体路径必须是容器可访问的本地文件句柄；不支持网络 URL、`data:` URI 或绝对路径。
- 用户从评论区重新打开小工具时，可读取有效的 `miniToolSnapshotInfo` 以恢复业务状态；恢复逻辑由开发者实现。
- `routed` 表示评论侧路由是否成功。相册保存失败时，原因通过可选字段 `albumFailReason` 返回。
