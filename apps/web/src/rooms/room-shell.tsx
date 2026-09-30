import type { ReactNode } from 'react';

/** 游玩中固定屏幕高度；等待室和结算页保留自然滚动，完整展示管理与答案。 */
export function RoomShell({ playing, children }: { playing: boolean; children: ReactNode }) {
  return <main className={`shell room-shell${playing ? ' room-playing' : ''}`}>{children}</main>;
}
