/**
 * 通知中心：站内通知列表（好友申请、私聊、房间邀请、站内信、系统公告）。
 * 标题由服务端按阅读者语言拼好，前端直接展示。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';

interface NotificationItem {
  id: string;
  type: 'dm' | 'friend_request' | 'friend_accepted' | 'room_invite' | 'announcement' | 'system';
  title: string;
  body: string | null;
  link: string | null;
  actorUserId: string | null;
  actorNickname: string | null;
  conversationId: string | null;
  roomId: string | null;
  announcementId: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsPage() {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: NotificationItem[] }>('/notifications'),
    retry: false,
  });

  const list = notifications.data?.notifications ?? [];

  const markAllRead = async () => {
    setError(null);
    try {
      await api<{ updated: number }>('/notifications/read', { method: 'POST', body: { all: true } });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError(translateApiError(err, language, copy.notificationsLoadFail));
    }
  };

  const openNotification = async (item: NotificationItem) => {
    setError(null);
    try {
      await api<{ updated: number }>('/notifications/read', { method: 'POST', body: { ids: [item.id] } });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError(translateApiError(err, language, copy.notificationsLoadFail));
    }
    if (item.link) navigate(item.link);
  };

  return (
    <main className="shell narrow">
      <header className="topbar topbar-title topbar-wide-actions">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.notificationsTitle}</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => void markAllRead()}>{copy.notificationsMarkAllRead}</button>
      </header>

      <section className="panel stack">
        {notifications.isPending ? (
          <p className="muted">{copy.loadingRound}</p>
        ) : notifications.isError ? (
          <p className="error-text" role="alert">{translateApiError(notifications.error, language, copy.notificationsLoadFail)}</p>
        ) : list.length === 0 ? (
          <p className="muted">{copy.notificationsEmpty}</p>
        ) : (
          <ul className="notification-list">
            {list.map((item) => (
              <li key={item.id}>
                <button
                  className={`notification-item${item.readAt === null ? ' is-unread' : ''}`}
                  onClick={() => void openNotification(item)}
                >
                  <span className="notification-title">{item.title}</span>
                  {item.body && <span className="notification-body">{item.body}</span>}
                  <span className="notification-time">
                    {new Date(item.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}
