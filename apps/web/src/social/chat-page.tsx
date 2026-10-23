/**
 * 私聊页：消息气泡 + 快捷开局「来一局」。
 * 消息每 3 秒轮询一次；拉完新消息顺手推进已读水位。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, type Language } from '@jev/i18n';
import { api, translateApiError } from '../api/client.js';
import { useJevSession } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';

interface DmMessage {
  id: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderNickname: string;
  kind: 'text' | 'room_invite';
  text: string;
  roomId: string | null;
  createdAt: string;
}

const POLL_MS = 3000;

/** 气泡时间：只到分钟。 */
function messageTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

export function ChatPage() {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/chat');
  const { conversationId } = useParams();
  const { session } = useJevSession();
  const queryClient = useQueryClient();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const markedSeqRef = useRef(-1);

  const messages = useQuery({
    queryKey: ['conversation-messages', conversationId],
    queryFn: () => api<{ messages: DmMessage[] }>(`/conversations/${conversationId}/messages`),
    enabled: conversationId !== undefined,
    refetchInterval: (q) => (q.state.error ? false : POLL_MS),
    retry: false,
  });

  const list = messages.data?.messages ?? [];
  const myUserId = session?.user.id ?? null;

  // 新消息到达时推进已读水位；同一个 seq 不重复上报。
  useEffect(() => {
    if (conversationId === undefined) return;
    const items = messages.data?.messages ?? [];
    const last = items[items.length - 1];
    if (!last || last.seq <= markedSeqRef.current) return;
    markedSeqRef.current = last.seq;
    void api<{ lastReadSeq: number; unreadCount: number }>(`/conversations/${conversationId}/read`, {
      method: 'POST',
      body: { lastReadSeq: last.seq },
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => {
        // 已读水位推进失败不影响阅读：退回一格，下一轮轮询再试
        markedSeqRef.current = last.seq - 1;
      });
  }, [conversationId, messages.data, queryClient]);

  // 新消息滚到底部
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.data]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || conversationId === undefined) return;
    setSending(true);
    setError(null);
    try {
      await api<{ message: DmMessage }>(`/conversations/${conversationId}/messages`, { method: 'POST', body: { text: body } });
      setText('');
      await messages.refetch();
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      setError(translateApiError(err, language, copy.chatSendFail));
    } finally {
      setSending(false);
    }
  };

  const startGame = async () => {
    if (starting || conversationId === undefined) return;
    setStarting(true);
    setError(null);
    try {
      const result = await api<{ roomId: string; message: DmMessage }>(`/conversations/${conversationId}/start-room`, {
        method: 'POST',
        body: { language: language === 'zh' ? 'zh' : 'en' },
      });
      navigate(`/rooms/${result.roomId}`);
    } catch (err) {
      setError(translateApiError(err, language, copy.chatStartGameFail));
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="shell narrow chat-shell">
      <header className="topbar topbar-title">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.chatTitle}</h1>
      </header>

      <div className="chat-actions">
        <button className="btn btn-sm" disabled={starting} onClick={() => void startGame()}>{copy.chatStartGame}</button>
      </div>

      <section className="chat-thread" ref={threadRef}>
        {messages.isPending ? (
          <p className="muted">{copy.loadingRound}</p>
        ) : messages.isError ? (
          <p className="error-text" role="alert">{translateApiError(messages.error, language, copy.chatMessagesLoadFail)}</p>
        ) : list.length === 0 ? (
          <p className="muted">{copy.chatEmpty}</p>
        ) : (
          list.map((msg) => (
            <div key={msg.id} className={`chat-msg${msg.senderUserId === myUserId ? ' is-mine' : ''}`}>
              {msg.kind === 'room_invite' ? (
                <div className="chat-card">
                  <p className="chat-card-text">{format(copy.chatRoomInvite, { title: msg.text })}</p>
                  {msg.roomId && (
                    <button className="btn btn-sm btn-primary" onClick={() => navigate(`/rooms/${msg.roomId}`)}>
                      {copy.chatEnterRoom}
                    </button>
                  )}
                </div>
              ) : (
                <p className="chat-bubble">{msg.text}</p>
              )}
              <span className="chat-msg-meta">{messageTime(msg.createdAt, language)}</span>
            </div>
          ))
        )}
      </section>

      {error && <p className="error-text" role="alert">{error}</p>}

      <form className="chat-input-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input
          className="field"
          type="text"
          value={text}
          placeholder={copy.chatInputPlaceholder}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={sending || text.trim().length === 0}>{copy.chatSend}</button>
      </form>
    </main>
  );
}
