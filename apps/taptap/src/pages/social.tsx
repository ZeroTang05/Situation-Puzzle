/** 好友、私聊与通知中心；私聊 3 秒轮询，通知 10 秒轮询，复用现有权限接口。 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { friendListResponseSchema, friendRequestListResponseSchema, friendSearchResponseSchema, dmMessageListResponseSchema, conversationDetailResponseSchema, notificationListResponseSchema, quickRoomResponseSchema } from '@jev/contracts';
import { api } from '../api.js';
import { confirm, isForeground, useLanguage } from '../runtime.js';
import { useEndpoint, useNavigation, useSession, useTask, Status, TaskStatus, type Route } from '../state.js';
import { Button, Card, Input, Row, Text, View } from '../ui/components.js';

/** 服务端通知路径只映射已支持的站内页面，邀请类型保持独立。 */
export function routeFromPath(path: string): Route {
  const [pathname] = path.split('?'); const parts = pathname!.split('/').filter(Boolean);
  if (parts[0] === 'room' && parts[1] === 'invite' && parts[2]) return { page: 'invite', kind: 'room', token: parts[2] };
  if (parts[0] === 'lobby' && parts[1] === 'invite' && parts[2]) return { page: 'invite', kind: 'lobby', token: parts[2] };
  const id = parts[1];
  if (id && parts[0] === 'rooms') return { page: 'room', id };
  if (id && parts[0] === 'lobbies') return { page: 'lobby', id };
  if (id && parts[0] === 'chat') return { page: 'chat', id };
  if (id && parts[0] === 'creations') return { page: 'editor', id };
  if (id && parts[0] === 'solo') return { page: 'solo', id };
  if (parts[0] === 'friends') return { page: 'friends' };
  if (parts[0] === 'notifications') return { page: 'notifications' };
  if (parts[0] === 'me') return { page: 'me' };
  if (parts[0] === 'settings') return { page: 'settings' };
  throw new Error('这条通知的页面暂不可打开');
}

export function Friends() {
  const { t } = useLanguage(); const { go } = useNavigation(); const client = useQueryClient(); const task = useTask();
  const friends = useEndpoint<z.infer<typeof friendListResponseSchema>>('/friends');
  const requests = useEndpoint<z.infer<typeof friendRequestListResponseSchema>>('/friends/requests', { interval: 10_000 });
  const [email, setEmail] = useState(''); const [message, setMessage] = useState(''); const [found, setFound] = useState<z.infer<typeof friendSearchResponseSchema> | null>(null);
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['api'] }); };
  return <View><Input label={t('好友邮箱', 'Friend’s email')} value={email} disabled={task.busy} maxLength={254} onChange={(value) => { setEmail(value); setFound(null); }} />
    <Button disabled={task.busy || !email.trim()} onPress={() => { void task.run(async () => setFound(await api(`/friends/search?email=${encodeURIComponent(email.trim())}`, {}, friendSearchResponseSchema))); }}>{t('查找好友', 'Find friend')}</Button>
    {found && <Card><Text>{found.found ? found.nickname : t('没有找到该用户', 'User not found')}</Text>
      {found.relation === 'none' && found.found && <View><Input label={t('附言', 'Message')} value={message} disabled={task.busy} maxLength={200} onChange={setMessage} /><Button disabled={task.busy} onPress={() => { void task.run(async () => { await api('/friends/requests', { body: { email: email.trim(), message } }); setFound({ ...found, relation: 'pending_outgoing' }); await refresh(); }); }}>{t('发送好友申请', 'Send request')}</Button></View>}
      {found.relation === 'friends' && <Text muted>{t('你们已经是好友', 'You are already friends')}</Text>}
      {found.relation === 'pending_outgoing' && <Text muted>{t('等待对方同意', 'Awaiting approval')}</Text>}
      {found.relation === 'self' && <Text muted>{t('这是你的账号', 'This is your account')}</Text>}
    </Card>}
    <TaskStatus task={task} /><Text size={21}>{t('好友申请', 'Friend requests')}</Text><Status query={requests} />
    {requests.data?.requests.filter((item) => item.status === 'pending').map((item) => <Card key={item.requestId}><Text>{item.nickname}</Text>{item.message && <Text muted>{item.message}</Text>}
      {item.direction === 'incoming' ? <Row>{[true, false].map((accept) => <Button key={String(accept)} disabled={task.busy} onPress={() => { void task.run(async () => { await api(`/friends/requests/${item.requestId}/review`, { body: { accept } }); await refresh(); }); }}>{accept ? t('同意', 'Accept') : t('拒绝', 'Decline')}</Button>)}</Row>
        : <Button disabled={task.busy} onPress={() => { void task.run(async () => { await api(`/friends/requests/${item.requestId}`, { method: 'DELETE' }); await refresh(); }); }}>{t('撤回申请', 'Cancel request')}</Button>}
    </Card>)}
    <Text size={21}>{t('我的好友', 'My friends')}</Text><Status query={friends} />
    {friends.data?.friends.length === 0 && <Text muted>{t('添加好友，一起喝汤。', 'Add a friend to play together.')}</Text>}
    {friends.data?.friends.map((friend) => <Card key={friend.userId}><Button disabled={!friend.conversationId} onPress={() => { if (friend.conversationId) go({ page: 'chat', id: friend.conversationId }); }}>{friend.nickname}</Button>
      <Button danger disabled={task.busy} onPress={() => { void task.run(async () => { if (!await confirm(t('删除好友', 'Remove friend'), friend.nickname)) return; await api(`/friends/${friend.userId}`, { method: 'DELETE' }); await refresh(); }); }}>{t('删除好友', 'Remove friend')}</Button>
    </Card>)}
  </View>;
}

export function Chat({ id }: { id: string }) {
  const { t, language } = useLanguage(); const { go } = useNavigation(); const { session } = useSession(); const task = useTask();
  const detail = useEndpoint<z.infer<typeof conversationDetailResponseSchema>>(`/conversations/${id}`);
  const query = useEndpoint<z.infer<typeof dmMessageListResponseSchema>>(`/conversations/${id}/messages`, { interval: 3000 });
  const draftKey = `jev.taptap.dm.${session!.user.id}:${id}`;
  const [text, setText] = useState(() => String(tap.getStorageSync(draftKey) || '')); const [readError, setReadError] = useState('');
  const marked = useRef(0); const messages = query.data?.messages; const latest = messages?.[messages.length - 1]?.seq ?? 0;
  const change = (value: string) => { setText(value); tap.setStorageSync(draftKey, value); };
  useEffect(() => {
    if (!isForeground() || latest <= marked.current) return;
    let alive = true;
    void api(`/conversations/${id}/read`, { body: { lastReadSeq: latest } }).then(() => { if (alive) { marked.current = latest; setReadError(''); } })
      .catch((error: unknown) => { console.error('[taptap:chat:read]', error); if (alive) setReadError(t('已读状态未同步', 'Read status could not be saved')); });
    return () => { alive = false; };
  }, [id, latest, query.dataUpdatedAt]);
  const send = (value: string) => task.run(async () => { const body = value.trim(); if (!body) return; await api(`/conversations/${id}/messages`, { body: { text: body } }); change(''); await query.refetch(); });
  return <View><Status query={detail} /><Text size={22}>{detail.data?.conversation.peerNickname ?? t('私聊', 'Chat')}</Text>
    <Button disabled={task.busy} onPress={() => { void task.run(async () => { await api(`/conversations/${id}/start-room`, { body: { language } }, quickRoomResponseSchema); await query.refetch(); }); }}>{t('来一局', 'Start a game')}</Button>
    <Status query={query} />{query.data?.messages.map((item) => <Card key={item.id}><Text muted size={13}>{item.senderNickname}</Text><Text>{item.text}</Text>
      {item.kind === 'room_invite' && <Button disabled={item.roomStatus === null || item.roomStatus === 'closed' || !item.inviteToken} onPress={() => { if (item.inviteToken) go({ page: 'invite', kind: 'room', token: item.inviteToken }); }}>{item.roomStatus === null || item.roomStatus === 'closed' ? t('房间已结束', 'Game ended') : t('进入房间', 'Enter room')}</Button>}
    </Card>)}
    {readError && <Text muted>{readError}</Text>}<TaskStatus task={task} />
    <Input label={t('消息', 'Message')} value={text} multiline maxLength={1000} disabled={task.busy} onChange={change} onSubmit={(value) => { void send(value); }} />
    <Button primary disabled={task.busy || !text.trim()} onPress={() => { void send(text); }}>{t('发送', 'Send')}</Button>
  </View>;
}

export function Notifications() {
  const { t } = useLanguage(); const { go } = useNavigation(); const task = useTask(); const client = useQueryClient();
  const query = useEndpoint<z.infer<typeof notificationListResponseSchema>>('/notifications', { interval: 10_000 });
  const mark = (ids?: string[]) => api('/notifications/read', { body: ids ? { ids } : { all: true } });
  return <View><Button disabled={task.busy} onPress={() => { void task.run(async () => { await mark(); await client.invalidateQueries({ queryKey: ['api'] }); }); }}>{t('全部已读', 'Mark all read')}</Button>
    <Status query={query} /><TaskStatus task={task} />
    {query.data?.notifications.length === 0 && <Text muted>{t('暂无通知', 'No notifications')}</Text>}
    {query.data?.notifications.map((item) => <Card key={item.id}><Text size={18}>{`${item.readAt ? '' : '● '}${item.title}`}</Text>{item.body && <Text>{item.body}</Text>}
      <Text muted size={12}>{new Date(item.createdAt).toLocaleString()}</Text><Button disabled={task.busy} onPress={() => { void task.run(async () => {
        await mark([item.id]); await client.invalidateQueries({ queryKey: ['api'] }); if (item.link) go(routeFromPath(item.link));
      }); }}>{item.link ? t('查看', 'Open') : t('标为已读', 'Mark as read')}</Button>
    </Card>)}
  </View>;
}
