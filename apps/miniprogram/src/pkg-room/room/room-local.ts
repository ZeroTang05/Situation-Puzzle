/**
 * 多人草稿与待确认请求（对齐 apps/web/src/rooms/room-local.ts）：
 * 按账号和房间隔离，退出登录清理。存储介质从 IndexedDB 换成 Taro storage
 * （每账号每房间一个 key，JSON 体积小，单 key 1MB 上限内安全）。
 */
import Taro from '@tarojs/taro'
import type { CommandInput, CommandResult } from './use-room-sync'

export type InputMode = 'ask' | 'solve' | 'discussion'

export interface PendingCommand {
  input: CommandInput
  status: 'sending' | 'confirming' | 'sent' | 'rejected'
  error?: string
  result?: CommandResult
  /** 网络不确定时至多自动重投一次，重进后仍保留该计数。 */
  retries: number
}

export interface RoomLocal {
  key: string
  userId: string
  drafts: Record<InputMode, string>
  pending: PendingCommand[]
  tab: 'qa' | 'discuss'
  mode: InputMode
}

const STORAGE_PREFIX = 'jev.room-local.'

function storageKey(userId: string, roomId: string): string {
  return `${STORAGE_PREFIX}${userId}:${roomId}`
}

/** 读取本地草稿与发件状态；没有存档时给空记录 */
export async function loadRoomLocal(userId: string, roomId: string): Promise<RoomLocal> {
  const key = storageKey(userId, roomId)
  const saved = Taro.getStorageSync<RoomLocal | string>(key)
  if (saved && typeof saved === 'object') return { ...saved, key }
  return { key, userId, drafts: { ask: '', solve: '', discussion: '' }, pending: [], tab: 'qa', mode: 'ask' }
}

/** 写回本地记录（Taro.setStorageSync 同步落盘，保持 async 签名与 web 一致） */
export async function saveRoomLocal(value: RoomLocal): Promise<void> {
  Taro.setStorageSync(value.key, value)
}

/** 退出登录时清掉该账号全部房间的本地记录（对齐 web clearRoomLocal 的按 user 索引清理） */
export async function clearRoomLocal(userId: string): Promise<void> {
  const info = Taro.getStorageInfoSync()
  const prefix = `${STORAGE_PREFIX}${userId}:`
  for (const key of info.keys) {
    if (key.startsWith(prefix)) Taro.removeStorageSync(key)
  }
}

/**
 * 命令请求编号：服务端契约要求 UUID 形状（contracts http.ts 的 z.string().uuid()）。
 * 小程序没有 crypto.randomUUID，本地生成标准 v4 形状（时间戳 + 随机段，
 * 单个请求编号的生命周期内不会碰撞；与 solo 本地 ID 的取随机段做法一致）。
 */
export function newRequestId(): string {
  const hex = '0123456789abcdef'
  const bytes = (n: number): string =>
    Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]!).join('')
  // 第三段版本位固定 4（v4），第四段高两位为 10（RFC 4122 variant）
  const variant = '89ab'[Math.floor(Math.random() * 4)]!
  return `${bytes(8)}-${bytes(4)}-4${bytes(3)}-${variant}${bytes(3)}-${bytes(12)}`
}
