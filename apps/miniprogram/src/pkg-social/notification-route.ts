/**
 * 通知跳转路径映射：网页端路由 → 小程序页面路径。
 *
 * 服务端的通知 `link` 字段是网页端的站内相对路径（apps/api/src/social/social.repository.ts
 * 的 notificationLink：/chat/:id、/friends、/notifications；chat.service.ts 开局邀请：
 * /room/invite/:token），通知中心点一条通知要跳到对应的小程序页面。
 * 映射表与公共须知「跨分包的统一路径」一致；映射不到的路径返回 null，
 * 调用方只标已读不跳转。
 *
 * 路径只按「网页端路由形状」解析，不解析查询串；小程序 URL 的参数值一律
 * encodeURIComponent（token / id 都是服务端生成的 hex / uuid，编码前后相同，
 * 但统一编码能挡住异常值把 URL 拼坏）。
 */

/** 一条映射规则：正则抓网页路径，build 用捕获组拼小程序路径 */
interface RouteRule {
  pattern: RegExp
  build: (match: RegExpExecArray) => string
}

const q = encodeURIComponent

const RULES: RouteRule[] = [
  { pattern: /^\/$/, build: () => '/pages/index/index' },
  { pattern: /^\/login$/, build: () => '/pages/login/login' },
  { pattern: /^\/me$/, build: () => '/pages/me/me' },
  { pattern: /^\/settings$/, build: () => '/pages/settings/settings' },
  { pattern: /^\/library$/, build: () => '/pages/library/library' },
  { pattern: /^\/solo\/([^/]+)$/, build: (m) => `/pages/solo/solo?puzzleId=${q(m[1]!)}` },
  { pattern: /^\/hall$/, build: () => '/pkg-room/pages/hall/hall' },
  { pattern: /^\/lobbies\/([^/]+)$/, build: (m) => `/pkg-room/pages/lobby/lobby?id=${q(m[1]!)}` },
  { pattern: /^\/rooms\/([^/]+)$/, build: (m) => `/pkg-room/pages/room/room?id=${q(m[1]!)}` },
  { pattern: /^\/lobby\/invite\/([^/]+)$/, build: (m) => `/pkg-room/pages/invite/invite?kind=lobby&token=${q(m[1]!)}` },
  { pattern: /^\/room\/invite\/([^/]+)$/, build: (m) => `/pkg-room/pages/invite/invite?kind=room&token=${q(m[1]!)}` },
  { pattern: /^\/friends$/, build: () => '/pkg-social/pages/friends/friends' },
  { pattern: /^\/chat\/([^/]+)$/, build: (m) => `/pkg-social/pages/chat/chat?id=${q(m[1]!)}` },
  { pattern: /^\/notifications$/, build: () => '/pkg-social/pages/notifications/notifications' },
  { pattern: /^\/creations$/, build: () => '/pkg-creation/pages/list/list' },
  { pattern: /^\/creations\/new$/, build: () => '/pkg-creation/pages/editor/editor' },
  { pattern: /^\/creations\/([^/]+)\/preview$/, build: (m) => `/pkg-creation/pages/preview/preview?id=${q(m[1]!)}` },
  { pattern: /^\/creations\/([^/]+)$/, build: (m) => `/pkg-creation/pages/editor/editor?id=${q(m[1]!)}` },
]

/**
 * 把网页端站内路径换成小程序页面路径；不认识的路径返回 null。
 * 只看路径段：带查询串 / 锚点的输入先截掉 `?` 与 `#` 之后的部分再匹配。
 */
export function miniProgramPathOf(webPath: string): string | null {
  const path = webPath.split(/[?#]/, 1)[0] ?? ''
  for (const rule of RULES) {
    const match = rule.pattern.exec(path)
    if (match) return rule.build(match)
  }
  return null
}
