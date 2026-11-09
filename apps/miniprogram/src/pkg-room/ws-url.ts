/**
 * 实时连接地址（对齐 apps/web/src/app-runtime.ts 的 wsUrl()）：
 * API_BASE 是 https，替换成 wss 后拼实时网关路径 /ws。
 * 域名 wss://sp.xiaobaozi.cn 需在小程序后台配置为 socket 合法域名。
 */
import { API_BASE } from '../api/client'

export function wsUrl(): string {
  return `${API_BASE.replace(/^http/, 'ws')}/ws`
}
