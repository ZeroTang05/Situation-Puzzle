/**
 * 同一用户当前占用的实时连接数（纯函数，便于单测）。
 *
 * 连接表是无界 Map：没有这道闸门，客户端可以随意开连接耗尽服务端内存。
 * 计数按「已认领身份」的连接算——未完成 auth 帧的连接还没有用户归属。
 */
export function countUserConnections(
  states: Iterable<{ userId: string | null }>,
  userId: string,
): number {
  let count = 0;
  for (const state of states) {
    if (state.userId === userId) count += 1;
  }
  return count;
}
