/** TapTap 本地单人存储。请求状态独立于页面，React 通过标准外部存储接口订阅。 */
import { savedGameSchema, recoverInterruptedSolo, type SavedGame } from './solo-state.js';

interface SoloSnapshot { game: SavedGame | null; busy: boolean; error: string; }
const stores = new Map<string, SoloStore>();

class SoloStore {
  private snapshot: SoloSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly key: string, initial: SavedGame | null) {
    const stored = tap.getStorageSync(key);
    const previous = stored ? savedGameSchema.parse(stored) : initial;
    const game = previous ? recoverInterruptedSolo(previous) : null;
    if (game && game !== previous) tap.setStorageSync(key, game);
    this.snapshot = { game, busy: false, error: '' };
  }

  getSnapshot = (): SoloSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); this.release(); }; };
  private emit(next: SoloSnapshot): void { this.snapshot = next; this.listeners.forEach((listener) => listener()); this.release(); }
  /** 没有页面订阅且请求已完成时释放内存，记录仍在宿主存储。 */
  private release(): void { if (!this.listeners.size && !this.snapshot.busy && stores.get(this.key) === this) stores.delete(this.key); }

  /** 同步落盘成功后才通知界面，写入失败在原处抛出。 */
  update(change: (game: SavedGame | null) => SavedGame | null): void {
    const game = change(this.snapshot.game);
    if (game === this.snapshot.game) return;
    if (game) tap.setStorageSync(this.key, game); else tap.removeStorageSync(this.key);
    this.emit({ ...this.snapshot, game });
  }

  /** 同一局一次只执行一个操作；离开页面后仍完成请求和持久化。 */
  async run(action: () => Promise<unknown>): Promise<void> {
    if (this.snapshot.busy) return;
    this.emit({ ...this.snapshot, busy: true, error: '' });
    try { await action(); }
    catch (error) {
      console.error('[taptap:solo]', error);
      this.emit({ ...this.snapshot, error: error instanceof Error ? error.message : String(error) });
    } finally { this.emit({ ...this.snapshot, busy: false }); }
  }
}

/** 同一记录始终复用一个存储实例，重进页面可观察仍在进行的请求。 */
export function getSoloStore(key: string, initial: SavedGame | null): SoloStore {
  let store = stores.get(key);
  if (!store) { store = new SoloStore(key, initial); stores.set(key, store); }
  return store;
}
