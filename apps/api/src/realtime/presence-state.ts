/** 把同一用户的多个实时连接合并为逐房间在线时间。 */
export function activeRoomsForUser(
  states: Iterable<{ userId: string | null; lastActiveAt: number; subscriptions: ReadonlyMap<string, unknown> }>,
  userId: string,
  now: number,
): Map<string, number> {
  const activeByRoom = new Map<string, number>();
  for (const state of states) {
    if (state.userId !== userId || state.lastActiveAt <= now - 60_000) continue;
    for (const roomId of state.subscriptions.keys()) {
      activeByRoom.set(roomId, Math.max(activeByRoom.get(roomId) ?? 0, state.lastActiveAt));
    }
  }
  return activeByRoom;
}
