/**
 * 邀请链接的 web 形态（对齐 apps/web/src/game/game-display.ts 的 inviteUrl）：
 * origin 固定生产域名，复制到剪贴板后由好友在浏览器打开。
 */
export function inviteWebLink(kind: 'lobby' | 'room', token: string): string {
  return `https://sp.xiaobaozi.cn/${kind}/invite/${encodeURIComponent(token)}`
}
