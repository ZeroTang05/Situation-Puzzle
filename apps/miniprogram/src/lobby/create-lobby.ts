/**
 * 拿我的会客厅（代码级对齐 apps/web/src/rooms/create-lobby.ts；小程序侧目录叫
 * lobby/，避免与分包目录 pkg-room/ 的「room」一词撞车）：
 * 服务端按 host_user_id UNIQUE 保证幂等，不存在就建，存在就返回同一个 id。
 * 首页「多人」与题库「开房」共用。
 */
import { api } from '../api/client'

export interface LobbyOpened {
  lobbyId: string
  /** true = 我已经有会客厅；false = 刚为我新建 */
  existed: boolean
}

export async function openOrGetLobby(): Promise<LobbyOpened> {
  // 容量由服务端 ROOM_CAPACITY 环境变量决定，客户端不传
  return api<LobbyOpened>('/lobbies', { method: 'POST', body: {} })
}

/** 会客厅页路径；selectPuzzle 用于题库选完题回跳提交（对齐 web 的 ?selectPuzzle=&lang=） */
export function lobbyPath(lobbyId: string, select?: { puzzleId: string; language: 'zh' | 'en' }): string {
  const base = `/pkg-room/pages/lobby/lobby?id=${lobbyId}`
  return select ? `${base}&selectPuzzle=${encodeURIComponent(select.puzzleId)}&lang=${select.language}` : base
}
