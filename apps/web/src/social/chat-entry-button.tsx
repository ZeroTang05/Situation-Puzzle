/**
 * 「消息」入口：首页与「我的」页共用。
 * 直接进最近一条会话；一条会话都没有就去好友页（加好友后才有会话）。
 */
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useJevSession } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';

export function ChatEntryButton({ className = 'btn btn-sm' }: { className?: string }) {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const { session } = useJevSession();

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<{ conversations: Array<{ conversationId: string }> }>('/conversations'),
    enabled: session !== null,
    retry: false,
  });

  const open = () => {
    const latest = conversations.data?.conversations[0];
    if (latest) navigate(`/chat/${latest.conversationId}`);
    else navigate('/friends');
  };

  return (
    <button className={className} onClick={open}>
      {copy.messages}
    </button>
  );
}
