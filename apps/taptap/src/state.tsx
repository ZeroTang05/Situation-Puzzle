/** 页面导航、账号与统一操作状态。所有网络查询按账号、语言隔离缓存。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthSession } from '@jev/contracts';
import { api, getSession, hasToken } from './api.js';
import { isForeground, useLanguage } from './runtime.js';
import { Button, Text, View } from './ui/components.js';

export type PickTarget = { lobbyId: string } | { sourceRoomId: string };
export type Route =
  | { page: 'home' | 'hall' | 'me' | 'settings' | 'friends' | 'notifications' | 'creations' | 'privacy' }
  | { page: 'login'; next?: Route }
  | { page: 'open-lobby'; puzzleId?: string; language?: 'zh' | 'en' }
  | { page: 'library'; pick?: PickTarget }
  | { page: 'solo'; id: string; language?: 'zh' | 'en' }
  | { page: 'lobby' | 'room' | 'chat' | 'editor' | 'preview'; id: string }
  | { page: 'invite'; kind: 'room' | 'lobby'; token: string };
interface Navigation { route: Route; go(route: Route, replace?: boolean): void; back(): void; scrollKey: string; resetScroll(): void; }
const NavigationContext = createContext<Navigation | null>(null);
const SessionContext = createContext<{ session: AuthSession; loading: boolean; error: Error | null; refresh(): Promise<AuthSession> } | null>(null);

export function NavigationProvider({ children, initial }: { children: ReactNode; initial: Route }) {
  const [history, setHistory] = useState<Route[]>([initial]);
  const [scrollVersion, setScrollVersion] = useState(0);
  const resetScroll = useCallback(() => setScrollVersion((value) => value + 1), []);
  return <NavigationContext value={{ route: history[history.length - 1]!,
    scrollKey: String(scrollVersion), resetScroll,
    go: (route, replace) => setHistory((old) => replace ? [...old.slice(0, -1), route] : [...old, route]),
    back: () => setHistory((old) => old.length > 1 ? old.slice(0, -1) : [{ page: 'home' }]),
  }}>{children}</NavigationContext>;
}
export function useNavigation(): Navigation { const value = useContext(NavigationContext); if (!value) throw new Error('缺少导航上下文'); return value; }

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['session'], queryFn: getSession, enabled: hasToken(), retry: false });
  return <SessionContext value={{ session: query.data ?? null, loading: hasToken() && query.isPending, error: query.error,
    refresh: async () => { await client.invalidateQueries(); const result = await query.refetch({ throwOnError: true }); return result.data ?? null; },
  }}>{children}</SessionContext>;
}
export function useSession() { const value = useContext(SessionContext); if (!value) throw new Error('缺少账号上下文'); return value; }

/** 普通查询复用 React Query，社交轮询保持原来的 3 秒 / 10 秒节奏。 */
export function useEndpoint<T>(path: string, options: { interval?: number; enabled?: boolean } = {}) {
  const { language } = useLanguage(); const { session } = useSession();
  const query = useQuery({ queryKey: ['api', session?.user.id ?? 'anonymous', language, path], queryFn: () => api<T>(path),
    enabled: options.enabled ?? true, retry: false,
  });
  // Query Core 在没有 window 的环境中关闭自动轮询；这里直接使用宿主计时器。
  useEffect(() => {
    if (!options.interval || options.enabled === false) return;
    const timer = setInterval(() => { if (isForeground() && !query.isFetching) void query.refetch(); }, options.interval);
    return () => clearInterval(timer);
  }, [options.interval, options.enabled, query.refetch, query.isFetching]);
  return query;
}

/** 操作失败立即展示具体错误，输入由各页面保留；同步锁防止连点重复执行。 */
export function useTask() {
  const locked = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try { await action(); } catch (error) {
      console.error('[taptap:action]', error); setError(error instanceof Error ? error.message : String(error));
    } finally { locked.current = false; setBusy(false); }
  };
  return { busy, error, run, clear: () => setError('') };
}
export function Status({ query }: { query: { isPending: boolean; error: Error | null; refetch(): unknown } }) {
  const { t } = useLanguage();
  if (query.error) return <View><Text>{query.error.message}</Text><Button onPress={() => { void query.refetch(); }}>{t('重试', 'Retry')}</Button></View>;
  return query.isPending ? <Text muted>{t('正在加载…', 'Loading…')}</Text> : null;
}
export function TaskStatus({ task }: { task: ReturnType<typeof useTask> }) {
  const { t } = useLanguage();
  return task.error ? <Text style={{ color: '#ffabb3' }}>{task.error}</Text> : task.busy ? <Text muted>{t('正在处理…', 'Working…')}</Text> : null;
}
