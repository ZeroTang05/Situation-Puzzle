/**
 * 通知铃铛：顶栏入口 + 未读角标。
 * 未登录不发请求（enabled 跟着会话走）；未读数每 10 秒轮询一次。
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useJevSession } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';

const POLL_MS = 10000;

export function NotificationBell({ onNavigate }: { onNavigate?: () => void }) {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const { session } = useJevSession();

  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api<{ unread: number }>('/notifications/unread-count'),
    enabled: session !== null,
    refetchInterval: POLL_MS,
    retry: false,
  });

  const count = unread.data?.unread ?? 0;

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm notification-bell"
      aria-label={copy.notifications}
      onClick={() => {
        onNavigate?.();
        navigate('/notifications');
      }}
    >
      <span aria-hidden>🔔</span>
      {count > 0 && <span className="notification-badge">{count > 99 ? '99+' : count}</span>}
    </button>
  );
}
