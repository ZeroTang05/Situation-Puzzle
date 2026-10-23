/**
 * 私聊会话列表：最近会话 + 未读数。
 * 轮询而非 WebSocket：私聊没有房间级事件流，3 秒一次与服务端限额对齐。
 */
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { format } from '@jev/i18n';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';

interface ConversationSummary {
  conversationId: string;
  peerUserId: string;
  peerNickname: string;
  lastMessage: { text: string; senderUserId: string; kind: 'text' | 'room_invite'; createdAt: string } | null;
  unreadCount: number;
}

const POLL_MS = 3000;

export function ChatListPage() {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<{ conversations: ConversationSummary[] }>('/conversations'),
    // 出错就停轮询，避免刷屏；重进页面自然会重试
    refetchInterval: (q) => (q.state.error ? false : POLL_MS),
    retry: false,
  });

  const list = conversations.data?.conversations ?? [];

  return (
    <main className="shell narrow">
      <header className="topbar topbar-title">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.chatTitle}</h1>
      </header>

      <section className="panel stack">
        {conversations.isPending ? (
          <p className="muted">{copy.loadingRound}</p>
        ) : conversations.isError ? (
          <p className="error-text" role="alert">{translateApiError(conversations.error, language, copy.chatLoadFail)}</p>
        ) : list.length === 0 ? (
          <p className="muted">{copy.chatEmpty}</p>
        ) : (
          <ul className="chat-list">
            {list.map((conv) => (
              <li key={conv.conversationId}>
                <button className="chat-row" onClick={() => navigate(`/chat/${conv.conversationId}`)}>
                  <span className="chat-row-main">
                    <span className="chat-row-title">{conv.peerNickname}</span>
                    {conv.lastMessage && <span className="chat-row-meta">{conv.lastMessage.text}</span>}
                  </span>
                  {conv.unreadCount > 0 && (
                    <span className="chat-row-unread">{format(copy.chatUnread, { n: conv.unreadCount })}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <button className="btn btn-sm" onClick={() => navigate('/friends')}>{copy.friends}</button>
      </section>
    </main>
  );
}
