/**
 * 拿我的会客厅：服务端按 host_user_id UNIQUE 物理保证幂等，
 * 不存在就建一个并返回 lobbyId；存在就返回同一个 id。
 *
 * 会客厅 id 永久不变（不像之前的内存 lobby 在重启后丢失），
 * 前端不需要做 auto-recreate 兜底。
 */
import { api } from '../api/client.js';

export interface LobbyOpened {
  lobbyId: string;
  /** true = 我已经有会客厅；false = 刚为我新建 */
  existed: boolean;
}

export async function openOrGetLobby(): Promise<LobbyOpened> {
  return api<LobbyOpened>('/lobbies', { method: 'POST', body: { capacity: 8 } });
}
