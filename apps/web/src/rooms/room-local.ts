/** 多人草稿与待确认请求：按账号和房间隔离，退出登录清理。 */
import { openDB, type DBSchema } from 'idb';
import type { CommandInput, CommandResult } from './use-room-sync.js';

export type InputMode = 'ask' | 'solve' | 'discussion';
export interface PendingCommand {
  input: CommandInput;
  status: 'sending' | 'confirming' | 'sent' | 'rejected';
  error?: string;
  result?: CommandResult;
  /** 网络不确定时至多自动重投一次，刷新后仍保留该计数。 */
  retries: number;
}
export interface RoomLocal {
  key: string;
  userId: string;
  drafts: Record<InputMode, string>;
  pending: PendingCommand[];
  tab: 'qa' | 'discuss';
  mode: InputMode;
}
interface RoomLocalDb extends DBSchema {
  rooms: { key: string; value: RoomLocal; indexes: { user: string } };
}
const db = () => openDB<RoomLocalDb>('jev-room-local', 1, {
  upgrade(database) { database.createObjectStore('rooms', { keyPath: 'key' }).createIndex('user', 'userId'); },
});
export async function loadRoomLocal(userId: string, roomId: string): Promise<RoomLocal> {
  const key = `${userId}:${roomId}`;
  return (await (await db()).get('rooms', key)) ?? { key, userId, drafts: { ask: '', solve: '', discussion: '' }, pending: [], tab: 'qa', mode: 'ask' };
}
export async function saveRoomLocal(value: RoomLocal): Promise<void> { await (await db()).put('rooms', value); }
export async function clearRoomLocal(userId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('rooms', 'readwrite');
  for (const key of await tx.store.index('user').getAllKeys(userId)) await tx.store.delete(key);
  await tx.done;
}
