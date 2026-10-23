/**
 * 好友页：按邮箱找站内用户、发送好友申请、处理收到的申请、好友列表。
 * 申请-同意制：对方同意后才成为好友。
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDialog } from '@jev/ui';
import type { Copy } from '@jev/i18n';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';

type FriendRelation = 'self' | 'friends' | 'pending_outgoing' | 'pending_incoming' | 'none';

interface FriendSearchResult {
  found: boolean;
  userId: string | null;
  nickname: string | null;
  relation: FriendRelation;
}

interface FriendSummary {
  userId: string;
  nickname: string;
  since: string;
  /** 与该好友的会话 id：点好友名直接进这个会话 */
  conversationId: string | null;
}

interface FriendRequestItem {
  requestId: string;
  direction: 'incoming' | 'outgoing';
  userId: string;
  nickname: string;
  message: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled';
  createdAt: string;
}

/** 关系文案：none 表示还没有关系，由调用方渲染「加好友」按钮。 */
function relationLabel(relation: FriendRelation, copy: Copy): string | null {
  switch (relation) {
    case 'self': return copy.friendsRelationSelf;
    case 'friends': return copy.friendsRelationFriends;
    case 'pending_outgoing': return copy.friendsRelationPendingOutgoing;
    case 'pending_incoming': return copy.friendsRelationPendingIncoming;
    default: return null;
  }
}

export function FriendsPage() {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const dialog = useDialog();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [searchEmail, setSearchEmail] = useState<string | null>(null);
  const [requestSent, setRequestSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: FriendSummary[] }>('/friends'),
    retry: false,
  });

  const requests = useQuery({
    queryKey: ['friend-requests'],
    queryFn: () => api<{ requests: FriendRequestItem[] }>('/friends/requests'),
    retry: false,
  });

  const search = useQuery({
    queryKey: ['friend-search', searchEmail],
    queryFn: () => api<FriendSearchResult>(`/friends/search?email=${encodeURIComponent(searchEmail ?? '')}`),
    enabled: searchEmail !== null,
    retry: false,
  });

  const friendList = friends.data?.friends ?? [];
  const pendingRequests = (requests.data?.requests ?? []).filter((item) => item.status === 'pending');
  const found = search.data?.found === true ? search.data : null;
  const foundRelation = found ? relationLabel(found.relation, copy) : null;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    setRequestError(null);
    setActionError(null);
    setRequestSent(false);
    setSearchEmail(trimmed);
  };

  const addFriend = async () => {
    if (sending || searchEmail === null) return;
    setSending(true);
    setRequestError(null);
    try {
      await api<{ requestId: string; status: string }>('/friends/requests', { method: 'POST', body: { email: searchEmail } });
      setRequestSent(true);
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] });
    } catch (err) {
      setRequestError(translateApiError(err, language, copy.friendsRequestFail));
    } finally {
      setSending(false);
    }
  };

  const review = async (requestId: string, accept: boolean) => {
    if (busyId) return;
    setBusyId(requestId);
    setActionError(null);
    try {
      await api<{ requestId: string; status: string }>(`/friends/requests/${requestId}/review`, { method: 'POST', body: { accept } });
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] });
      await queryClient.invalidateQueries({ queryKey: ['friends'] });
      // 同意后服务端建会话：会话列表也要跟着刷新
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      setActionError(translateApiError(err, language, copy.friendsActionFail));
    } finally {
      setBusyId(null);
    }
  };

  const cancelRequest = async (requestId: string) => {
    if (busyId) return;
    setBusyId(requestId);
    setActionError(null);
    try {
      await api<{ ok: boolean }>(`/friends/requests/${requestId}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] });
    } catch (err) {
      setActionError(translateApiError(err, language, copy.friendsActionFail));
    } finally {
      setBusyId(null);
    }
  };

  const removeFriend = async (userId: string) => {
    if (removingId) return;
    if (!(await dialog.confirm(copy.friendsRemoveConfirm, copy.friendsRemove))) return;
    setRemovingId(userId);
    setActionError(null);
    try {
      await api<{ ok: boolean }>(`/friends/${userId}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['friends'] });
    } catch (err) {
      setActionError(translateApiError(err, language, copy.friendsActionFail));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <main className="shell narrow">
      <header className="topbar topbar-title">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.friendsTitle}</h1>
      </header>

      {/* 搜索区：按邮箱精确查找站内用户 */}
      <section className="panel stack">
        <form className="social-search" onSubmit={submitSearch}>
          <input
            className="field"
            type="email"
            value={email}
            placeholder={copy.friendsSearchPlaceholder}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">{copy.friendsSearch}</button>
        </form>

        {searchEmail !== null && (
          <div className="stack-sm">
            {search.isPending && <p className="muted">{copy.loadingRound}</p>}
            {search.isError && (
              <p className="error-text" role="alert">{translateApiError(search.error, language, copy.friendsLoadFail)}</p>
            )}
            {search.data && !search.data.found && <p className="muted">{copy.friendsSearchEmpty}</p>}
            {found && (
              <div className="friend-row">
                <div className="friend-row-main">
                  <p className="friend-row-name">{found.nickname ?? ''}</p>
                  {foundRelation && <p className="friend-row-extra muted">{foundRelation}</p>}
                </div>
                {found.relation === 'none' ? (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={sending || requestSent}
                    onClick={() => void addFriend()}
                  >
                    {requestSent ? copy.friendsRequestSent : copy.friendsAdd}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {requestError && <p className="error-text" role="alert">{requestError}</p>}
      </section>

      {/* 好友申请：收到的可同意/拒绝，发出的可撤回 */}
      <section className="panel stack">
        <h3>{copy.friendsRequestsTitle}</h3>
        {requests.isPending ? (
          <p className="muted">{copy.loadingRound}</p>
        ) : requests.isError ? (
          <p className="error-text" role="alert">{translateApiError(requests.error, language, copy.friendsLoadFail)}</p>
        ) : pendingRequests.length === 0 ? (
          <p className="muted">{copy.friendsRequestsEmpty}</p>
        ) : (
          <ul className="friend-list">
            {pendingRequests.map((item) => (
              <li key={item.requestId} className="friend-row">
                <div className="friend-row-main">
                  <p className="friend-row-name">{item.nickname}</p>
                  {item.message && <p className="friend-row-extra muted">{item.message}</p>}
                </div>
                {item.direction === 'incoming' ? (
                  <div className="friend-row-actions">
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyId !== null}
                      onClick={() => void review(item.requestId, true)}
                    >
                      {copy.friendsAccept}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busyId !== null}
                      onClick={() => void review(item.requestId, false)}
                    >
                      {copy.friendsReject}
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-sm"
                    disabled={busyId !== null}
                    onClick={() => void cancelRequest(item.requestId)}
                  >
                    {copy.friendsCancelRequest}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 我的好友 */}
      <section className="panel stack">
        <h3>{copy.friendsListTitle}</h3>
        {friends.isPending ? (
          <p className="muted">{copy.loadingRound}</p>
        ) : friends.isError ? (
          <p className="error-text" role="alert">{translateApiError(friends.error, language, copy.friendsLoadFail)}</p>
        ) : friendList.length === 0 ? (
          <p className="muted">{copy.friendsListEmpty}</p>
        ) : (
          <ul className="friend-list">
            {friendList.map((friend) => (
              <li key={friend.userId} className="friend-row">
                {/* 好友名整行可点：点谁就跟谁私聊（没有会话时不可点） */}
                <button
                  type="button"
                  className="friend-row-open"
                  disabled={friend.conversationId === null}
                  onClick={() => friend.conversationId && navigate(`/chat/${friend.conversationId}`)}
                >
                  <span className="friend-row-name">{friend.nickname}</span>
                  <span className="friend-row-chevron" aria-hidden>›</span>
                </button>
                <div className="friend-row-actions">
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={removingId !== null}
                    onClick={() => void removeFriend(friend.userId)}
                  >
                    {copy.friendsRemove}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {actionError && <p className="error-text" role="alert">{actionError}</p>}
    </main>
  );
}
