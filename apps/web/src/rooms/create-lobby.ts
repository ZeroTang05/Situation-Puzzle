/** 开房动作：创建内存等待室并保存邀请令牌（房主单例：已有等待室返回同一个）。 */
import { api } from '../api/client.js';

export interface LobbyCreated {
  lobbyId: string;
  inviteToken: string;
  existing: boolean;
}

export async function createLobby(): Promise<LobbyCreated> {
  const result = await api<LobbyCreated>('/lobbies', { method: 'POST', body: { capacity: 8 } });
  localStorage.setItem(`jev.lobby-invite.${result.lobbyId}`, result.inviteToken);
  return result;
}
