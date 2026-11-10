/** 会客厅、邀请、大厅和多人房间；房间控制统一经过可靠命令通道。 */
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { hallResponseSchema, lobbySnapshotSchema, lobbyCreateResponseSchema, lobbyStartResponseSchema, publicRoomJoinResponseSchema, lobbyPreviewSchema, invitePreviewSchema, canRateRoomPuzzle } from '@jev/contracts';
import { confidenceLabel, displayVerdict } from '@jev/i18n';
import { api } from '../api.js';
import { confirm, copyText, onHide, onShow, useLanguage } from '../runtime.js';
import { useEndpoint, useNavigation, useSession, useTask, Status, TaskStatus } from '../state.js';
import { Badge, Button, Card, Choice, Input, Row, SectionTitle, Text, View } from '../ui/components.js';
import { useRoomSync } from '../rooms/use-room-sync.js';
import { useRoomOutbox } from '../rooms/use-room-outbox.js';
import { useLobbySync } from '../rooms/use-lobby-sync.js';
import { Rating } from './catalog.js';
import { canShare, shareInvite } from '../share.js';
import { showGameEndAd } from '../ads.js';
import { hasPendingInput, pendingRoomMessages } from '../rooms/message-delivery.js';

/** 登录后延续开房意图；从题库发起时先把所选题目写入本人的固定会客厅。 */
export function LobbyLauncher({ puzzleId, language }: { puzzleId?: string; language?: 'zh' | 'en' }) {
  const { go } = useNavigation(); const { t, language: currentLanguage } = useLanguage(); const task = useTask(); const started = useRef(false);
  const active = useRef(true);
  const launch = () => task.run(async () => {
    const result = await api('/lobbies', { body: {} }, lobbyCreateResponseSchema);
    if (!active.current) return;
    if (puzzleId) await api(`/lobbies/${result.lobbyId}/select`, { body: { puzzleId, language: language ?? currentLanguage } });
    if (active.current) go({ page: 'lobby', id: result.lobbyId }, true);
  });
  useEffect(() => { if (!started.current) { started.current = true; void launch(); } }, []);
  useEffect(() => () => { active.current = false; }, []);
  return <View><Text>{t('正在打开会客厅…', 'Opening your lobby…')}</Text><TaskStatus task={task} />
    {task.error && <Button disabled={task.busy} onPress={() => { void launch(); }}>{t('重试', 'Retry')}</Button>}
  </View>;
}

export function Hall() {
  const { t } = useLanguage(); const { go } = useNavigation(); const task = useTask(); const query = useEndpoint<z.infer<typeof hallResponseSchema>>('/hall', { interval: 5000 });
  const [link, setLink] = useState('');
  return <View><Text size={24} style={{ fontWeight: 'bold' }}>{t('大厅', 'Game lobby')}</Text><Text muted size={14}>{t('加入公开房间，或者打开朋友发来的邀请。', 'Join a public room or open a friend’s invitation.')}</Text>
    <Card style={{ padding: 14, backgroundColor: '#102b3b' }}><Button primary disabled={task.busy} onPress={() => { void task.run(async () => { const result = await api('/lobbies', { body: {} }, lobbyCreateResponseSchema); go({ page: 'lobby', id: result.lobbyId }); }); }}>{t('我的会客厅', 'My lobby')}</Button>
    <Input label={t('房间或会客厅邀请链接', 'Room or lobby invitation link')} value={link} onChange={setLink} maxLength={2000} />
    <Button disabled={task.busy || !link.trim()} onPress={() => { void task.run(async () => {
      const result = /\/(room|lobby)\/invite\/([a-f0-9]+)/i.exec(link.trim());
      if (!result) throw new Error(t('请输入完整的房间或会客厅邀请链接', 'Enter a room or lobby invitation link'));
      go({ page: 'invite', kind: result[1]!.toLowerCase() as 'room' | 'lobby', token: result[2]! });
    }); }}>{t('打开邀请', 'Open invitation')}</Button></Card>
    <TaskStatus task={task} /><SectionTitle>{t('公开房间', 'Public rooms')}</SectionTitle><Status query={query} />
    {query.data?.rooms.length === 0 && <Text muted>{t('暂时没有公开房间，开一局邀请朋友吧。', 'No public rooms. Start one with friends.')}</Text>}
    {query.data?.rooms.map((room) => <Card key={room.roomId} style={{ padding: 14 }}><Text size={19} style={{ fontWeight: 'bold' }}>{room.title ?? t('海龟汤', 'Puzzle')}</Text><Text muted size={13}>{`${room.hostNickname} · ${room.memberCount}/${room.capacity}`}</Text>
      <Badge tone={room.full ? 'danger' : 'accent'}>{room.full ? t('已满员', 'Full') : room.status === 'waiting' ? t('等待开局', 'Waiting') : t('进行中', 'Playing')}</Badge>
      <Button primary={!room.full} disabled={task.busy || room.full} onPress={() => { void task.run(async () => { const result = await api(`/rooms/${room.roomId}/join-public`, { method: 'POST' }, publicRoomJoinResponseSchema); go({ page: 'room', id: result.roomId }); }); }}>{room.full ? t('已满员', 'Full') : t('加入', 'Join')}</Button>
    </Card>)}
  </View>;
}

export function Invite({ kind, token }: { kind: 'room' | 'lobby'; token: string }) {
  const { t } = useLanguage(); const { go } = useNavigation(); const task = useTask();
  const query = useEndpoint<z.infer<typeof lobbyPreviewSchema> | z.infer<typeof invitePreviewSchema>>(`/invites/${kind}/${encodeURIComponent(token)}`);
  const data = query.data;
  return <View><Status query={query} /><TaskStatus task={task} />{data && <Card style={{ padding: 18, backgroundColor: '#102b3b' }}><Badge tone="accent">{kind === 'lobby' ? t('会客厅邀请', 'Lobby invitation') : t('房间邀请', 'Room invitation')}</Badge><Text size={22} style={{ fontWeight: 'bold' }}>{`${data.hostNickname}${t('邀请你一起喝汤', ' invited you to play')}`}</Text><Text muted>{`${data.memberCount}/${data.capacity}`}</Text>
    {'currentPuzzleTitle' in data && data.currentPuzzleTitle && <Text>{data.currentPuzzleTitle}</Text>}
    <Button primary disabled={task.busy || ('status' in data && data.status === 'closed')} onPress={() => { void task.run(async () => {
      if (kind === 'lobby') { const joined = await api<{ lobbyId: string }>('/lobbies/join', { body: { token } }); go({ page: 'lobby', id: joined.lobbyId }, true); }
      else { const joined = await api<{ roomId: string }>('/rooms/join', { body: { token } }); tap.setStorageSync(`jev.invite.${joined.roomId}`, token); go({ page: 'room', id: joined.roomId }, true); }
    }); }}>{'status' in data && data.status === 'closed' ? t('房间已结束', 'Game ended') : t('加入', 'Join')}</Button>
  </Card>}</View>;
}

export function Lobby({ id }: { id: string }) {
  const { t } = useLanguage(); const { go } = useNavigation(); const { session } = useSession(); const task = useTask();
  const query = useEndpoint<z.infer<typeof lobbySnapshotSchema>>(`/lobbies/${id}`, { interval: 2000 });
  const sync = useLobbySync(id, (event) => { if (event.inviteToken) tap.setStorageSync(`jev.invite.${event.roomId}`, event.inviteToken); go({ page: 'room', id: event.roomId }, true); });
  useEffect(() => { const stopShow = onShow(sync.wake); const stopHide = onHide(sync.pause); return () => { stopShow(); stopHide(); }; }, [id]);
  const lobby = query.data; const host = lobby?.hostUserId === session?.user.id; const userHost = lobby?.userHostId === session?.user.id;
  const change = (path: string, body?: unknown) => task.run(async () => { await api(`/lobbies/${id}${path}`, { method: 'POST', ...(body !== undefined && { body }) }); await query.refetch(); });
  return <View><Status query={query} /><TaskStatus task={task} />{lobby && <View>
    <Text size={24} style={{ fontWeight: 'bold' }}>{t('会客厅', 'Lobby')}</Text><Badge tone={lobby.isPublic ? 'accent' : 'muted'}>{`${lobby.members.length}/${lobby.capacity} · ${lobby.isPublic ? t('下一局公开', 'Next public') : t('下一局私人', 'Next private')}`}</Badge>
    <Card style={{ padding: 14, backgroundColor: '#102b3b' }}><Text muted size={12}>{t('当前题目', 'Current puzzle')}</Text><Text size={19} style={{ fontWeight: 'bold' }}>{lobby.selectedPuzzle?.title ?? t('尚未选题', 'Choose a puzzle')}</Text>{host && <Button primary onPress={() => go({ page: 'library', pick: { lobbyId: id } })}>{t('选一碗汤', 'Choose puzzle')}</Button>}</Card>
    {host && <View><Button disabled={task.busy} onPress={() => { void change('/visibility', { isPublic: !lobby.isPublic }); }}>{lobby.isPublic ? t('下一局：公开', 'Next game: public') : t('下一局：私人', 'Next game: private')}</Button>
      <Button primary disabled={task.busy || !lobby.selectedPuzzle} onPress={() => { void task.run(async () => { const result = await api(`/lobbies/${id}/start`, { method: 'POST' }, lobbyStartResponseSchema); tap.setStorageSync(`jev.invite.${result.roomId}`, result.inviteToken); go({ page: 'room', id: result.roomId }, true); }); }}>{t('开始本局', 'Start game')}</Button>
      <Button disabled={task.busy} onPress={() => { void task.run(async () => { const result = await api<{ token: string }>(`/lobbies/${id}/invite`, { method: 'POST' }); await copyText(`${__API_BASE__}/lobby/invite/${result.token}`); }); }}>{t('复制邀请链接', 'Copy invitation')}</Button>
      {canShare() && <Button disabled={task.busy} onPress={() => { void task.run(async () => { const result = await api<{ token: string }>(`/lobbies/${id}/invite`, { method: 'POST' }); await shareInvite('lobby', result.token); }); }}>{t('邀请 TapTap 好友', 'Invite TapTap friends')}</Button>}
    </View>}
    {!host && <Text muted>{lobby.selectedPuzzle ? t('等待房主开始本局。', 'Waiting for the owner to start.') : t('等待房主选题并开始。', 'Waiting for the owner to choose a puzzle and start.')}</Text>}
    {lobby.hostMode === 'user' && <Card style={{ padding: 12, backgroundColor: '#173446' }}><Text muted size={13}>{t('本局由玩家主持，提问和还原会等待主持人判定。', 'A player is hosting this game. Questions and solutions wait for the host.')}</Text></Card>}
    <SectionTitle>{t('玩家', 'Players')}</SectionTitle>
    {lobby.members.map((member) => <Card key={member.userId}><Text>{`${member.nickname}${member.isHost ? t(' · 房主', ' · Owner') : ''}${member.isUserHost ? t(' · 主持人', ' · Host') : ''}`}</Text>
      {host && !member.isHost && <Button danger disabled={task.busy} onPress={() => { void task.run(async () => { if (await confirm(t('移出玩家', 'Remove player'), member.nickname)) { await api(`/lobbies/${id}/kick`, { body: { userId: member.userId } }); await query.refetch(); } }); }}>{t('移出', 'Remove')}</Button>}
      {host && member.isUserHost && <Button disabled={task.busy} onPress={() => { void change('/host/revoke', { userId: member.userId }); }}>{t('撤销主持身份', 'Revoke host')}</Button>}
    </Card>)}
    <Button disabled={task.busy} onPress={() => { void change(userHost ? '/host/resign' : '/host/request'); }}>{userHost ? t('退出主持', 'Stop hosting') : t('申请当主持人', 'Request to host')}</Button>
    {host && lobby.hostRequests.map((item) => <Card key={item.userId}><Text>{`${item.nickname} · ${t('申请主持', 'Host request')}`}</Text><Row><Button disabled={task.busy} onPress={() => { void change('/host/approve', { userId: item.userId }); }}>{t('同意', 'Approve')}</Button><Button disabled={task.busy} onPress={() => { void change('/host/reject', { userId: item.userId }); }}>{t('拒绝', 'Decline')}</Button></Row></Card>)}
    <Button danger disabled={task.busy} onPress={() => { void task.run(async () => { if (!await confirm(host ? t('解散会客厅', 'Dismiss lobby') : t('离开会客厅', 'Leave lobby'), t('确定继续吗？', 'Continue?'))) return; await api(`/lobbies/${id}${host ? '' : '/leave'}`, { method: host ? 'DELETE' : 'POST' }); go({ page: 'home' }, true); }); }}>{host ? t('解散会客厅', 'Dismiss lobby') : t('离开会客厅', 'Leave lobby')}</Button>
  </View>}</View>;
}

/** 房间输入、待确认请求与权威快照分别保存，主持人的汤底只请求私有接口。 */
export function Room({ id }: { id: string }) {
  const { language, t } = useLanguage(); const { go } = useNavigation(); const { session } = useSession(); const userId = session?.user.id ?? null; const task = useTask();
  const sync = useRoomSync(id, userId); const state = sync.state;
  const outbox = useRoomOutbox(userId, id, state, sync.status, sync.sendCommand, sync.confirmResult);
  const local = outbox.local; const round = state?.round; const host = state?.hostUserId === userId; const userHost = state?.userHostId === userId;
  const pendingCurrent = local ? hasPendingInput(local.pending, local.mode) : false;
  const translated = useEndpoint<{ title: string; surface: string }>(`/puzzles/${round?.puzzleId}?language=${language}`, { enabled: Boolean(round && round.language !== language) });
  const [largeModel, setLargeModel] = useState(false); const [answer, setAnswer] = useState('');
  const previousStatus = useRef<string | null>(null);
  useEffect(() => {
    if (previousStatus.current === 'playing' && state?.roomStatus === 'closed') void showGameEndAd();
    if (state) previousStatus.current = state.roomStatus;
  }, [state?.roomStatus]);
  const secret = useEndpoint<{ answer: string; hints: string[] }>(`/rounds/${round?.roundId}/host-view`, { enabled: Boolean(userHost && round) });
  useEffect(() => { if (!userHost) setAnswer(''); }, [userHost]);
  const command = (type: string, payload: Record<string, unknown> = {}, control = true) => task.run(async () => {
    if (!state || !round) return;
    const result = await outbox.submit({ type, roundId: round.roundId, ...(control && { expectedControlVersion: state.controlVersion }), payload });
    if (result?.inviteToken) { tap.setStorageSync(`jev.invite.${id}`, result.inviteToken); await copyText(`${__API_BASE__}/room/invite/${result.inviteToken}`); }
    if (result && (type === 'leave' || type === 'close_room')) go({ page: 'home' }, true);
  });
  const ready = sync.status === 'ready' && !task.busy;
  const send = (value: string) => task.run(async () => { if (!local || !round || pendingCurrent || !value.trim()) return; await outbox.submit({ type: local.mode, roundId: round.roundId, payload: { text: value.trim(), ...(local.mode === 'solve' && { useLargeModel: largeModel }) } }); });
  if (sync.status === 'forbidden') return <Text>{t('你已离开或被移出该房间。', 'You do not have access to this room.')}</Text>;
  if (sync.status === 'auth_required') return <Button onPress={() => go({ page: 'login', next: { page: 'room', id } })}>{t('重新登录', 'Sign in again')}</Button>;
  return <View><Row style={{ alignItems: 'center', justifyContent: 'space-between' }}><Text size={24} style={{ fontWeight: 'bold' }}>{t('房间', 'Room')}</Text><Badge tone={sync.status === 'ready' ? 'accent' : 'danger'}>{({ connecting: t('连接中', 'Connecting'), syncing: t('同步中', 'Syncing'), ready: t('已连接', 'Connected'), reconnecting: t('重连中', 'Reconnecting'), offline: t('离线', 'Offline'), forbidden: '', auth_required: '' })[sync.status]}</Badge></Row>
    {sync.status !== 'ready' && <Button onPress={sync.wake}>{t('重新连接', 'Reconnect')}</Button>}
    <TaskStatus task={task} />{outbox.storageError && <Text>{outbox.storageError}</Text>}
    {state && round && <View>{round.language !== language && <Status query={translated} />}<Text size={24} style={{ fontWeight: 'bold' }}>{round.language === language ? round.title : translated.data?.title ?? ''}</Text><Card style={{ padding: 14, backgroundColor: '#102b3b' }}><Text>{round.language === language ? round.surface : translated.data?.surface ?? ''}</Text></Card>
      <Choice value={local?.tab ?? 'qa'} options={[[ 'qa', t('问答', 'Questions') ], [ 'discuss', t('讨论', 'Discussion') ]]} onChange={(tab) => { void task.run(() => outbox.update((value) => ({ ...value, tab, mode: tab === 'discuss' ? 'discussion' : 'ask' }))); }} />
      {local?.tab === 'discuss' ? state.discussions.map((item) => <Card key={item.eventId} style={{ padding: 13 }}><Text muted size={12}>{item.nickname}</Text><Text>{item.text}</Text></Card>) : state.turns.map((turn) => <Card key={turn.turnId} style={{ padding: 13, backgroundColor: turn.kind === 'ask' ? '#173446' : '#142b3a' }}>
        <Text muted size={13}>{`${turn.nickname} · ${turn.kind === 'ask' ? t('提问', 'Question') : t('还原', 'Solution')}`}</Text><Text>{turn.text}</Text>
        <Text style={{ color: '#7dd8c6' }}>{turn.result ? displayVerdict(turn.result, language) : turn.status === 'queued' ? (state.hostMode === 'user' ? t('等待主持人判定', 'Waiting for host') : t('排队中', 'Queued')) : turn.status === 'processing' ? t('判定中…', 'Judging…') : turn.status === 'failed' ? t('判定失败', 'Judging failed') : t('已取消', 'Cancelled')}</Text>
        {turn.source !== 'host' && typeof turn.confidence === 'number' && <Text muted size={12}>{confidenceLabel(turn.confidence, language)}</Text>}
        {turn.userId === userId && turn.status === 'queued' && <Button disabled={!ready} onPress={() => { void command('cancel_turn', { turnId: turn.turnId }, false); }}>{t('取消提问', 'Cancel question')}</Button>}
        {userHost && turn.status === 'queued' && <Row>{(turn.kind === 'ask' ? ['yes', 'no', 'irrelevant'] : ['solved', 'close', 'not_yet']).map((verdict) => <Button key={verdict} disabled={!ready} onPress={() => { void command('host_answer', { turnId: turn.turnId, verdict }); }}>{displayVerdict(verdict, language)}</Button>)}</Row>}
      </Card>)}
      {pendingRoomMessages(local?.pending ?? [], state, local?.tab ?? 'qa').map((item) => <Card key={item.input.clientRequestId}>
        <Text>{String(item.input.payload?.text ?? '')}</Text>
        {item.status !== 'sent' && <Text muted>{item.error ?? t('正在发送…', 'Sending…')}</Text>}
        {item.status === 'confirming' && <Button disabled={!ready} onPress={() => { void task.run(() => outbox.retry(item)); }}>{t('确认发送结果', 'Check result')}</Button>}
      </Card>)}
      {round.hints.map((hint, index) => <Card key={index}><Text muted>{`${t('提示', 'Hint')} ${index + 1}`}</Text><Text>{hint}</Text></Card>)}
      {state.roomStatus === 'closed' && <Card><Text>{t('本局已结束', 'Game ended')}</Text>{round.answer || answer ? <Text>{round.answer || answer}</Text> : <Button disabled={task.busy} onPress={() => { void task.run(async () => { const result = await api<{ answer: string }>(`/rounds/${round.roundId}/answer`); setAnswer(result.answer); }); }}>{t('查看汤底', 'View answer')}</Button>}
        {host && <Button onPress={() => go({ page: 'library', pick: { sourceRoomId: id } })}>{t('再来一题', 'Play another')}</Button>}
        {state.followupTargetRoomId && <Button onPress={() => go({ page: 'room', id: state.followupTargetRoomId! }, true)}>{t('进入下一局', 'Next game')}</Button>}
      </Card>}
      {userHost && <Card><Text size={19}>{t('主持人汤底', 'Host answer')}</Text><Status query={secret} />{secret.data && <View><Text>{secret.data.answer}</Text>{secret.data.hints.map((hint, index) => <Text key={index}>{hint}</Text>)}</View>}</Card>}
      {local && state.roomStatus === 'playing' && <View>
        {local.tab === 'qa' && <Choice value={local.mode} options={[[ 'ask', t('问 Jev', 'Ask Jev') ], [ 'solve', t('还原真相', 'Solve') ]]} onChange={(mode) => { void task.run(() => outbox.update((value) => ({ ...value, mode }))); }} />}
        {local.mode === 'solve' && state.hostMode === 'ai' && <Button disabled={task.busy || pendingCurrent} onPress={() => setLargeModel(!largeModel)}>{`${largeModel ? '✓ ' : ''}${t('大模型判定', 'Large model')}`}</Button>}
        {(!userHost || local.mode === 'discussion') && <View><Input key={local.mode} label={local.mode === 'discussion' ? t('讨论', 'Discussion') : local.mode === 'ask' ? t('你的问题', 'Your question') : t('你的还原', 'Your solution')} value={local.drafts[local.mode]} multiline maxLength={local.mode === 'ask' ? 500 : local.mode === 'solve' ? 1500 : 1000} disabled={task.busy}
          onChange={(text) => { void outbox.update((value) => ({ ...value, drafts: { ...value.drafts, [local.mode]: text } })).catch((error) => console.error('[taptap:draft]', error)); }} onSubmit={(value) => { void send(value); }} />
        <Button primary disabled={!ready || pendingCurrent || !local.drafts[local.mode].trim()} onPress={() => { void send(local.drafts[local.mode]); }}>{t('发送', 'Send')}</Button>
        </View>}
        {host && <View><Button disabled={!ready} onPress={() => { void command('reveal_hint'); }}>{t('公布提示', 'Reveal hint')}</Button>
          <Button disabled={!ready} onPress={() => { void task.run(async () => { if (await confirm(t('揭晓汤底', 'Reveal answer'), t('揭晓后本局结束，确定继续吗？', 'Revealing ends this game. Continue?'))) await outbox.submit({ type: 'reveal_answer', roundId: round.roundId, expectedControlVersion: state.controlVersion, payload: {} }); }); }}>{t('揭晓汤底', 'Reveal answer')}</Button>
          <Button disabled={!ready} onPress={() => { void command('set_visibility', { isPublic: !state.isPublic }); }}>{state.isPublic ? t('公开房间', 'Public room') : t('私人房间', 'Private room')}</Button>
          <Button disabled={!ready} onPress={() => { void command('rotate_invite'); }}>{t('生成并复制新邀请', 'New invitation')}</Button>
          <Button disabled={!ready} danger onPress={() => { void task.run(async () => { if (await confirm(t('结束本局', 'End game'), t('确定结束本局吗？', 'End this game?'))) await outbox.submit({ type: 'end_round', roundId: round.roundId, expectedControlVersion: state.controlVersion, payload: {} }); }); }}>{t('结束本局', 'End game')}</Button>
          <Button disabled={!ready} danger onPress={() => { void task.run(async () => { if (!await confirm(t('关闭房间', 'Close room'), t('确定关闭当前房间吗？', 'Close this room?'))) return; const result = await outbox.submit({ type: 'close_room', roundId: round.roundId, expectedControlVersion: state.controlVersion, payload: {} }); if (result) go({ page: 'home' }, true); }); }}>{t('关闭房间', 'Close room')}</Button>
        </View>}
        {typeof tap.getStorageSync(`jev.invite.${id}`) === 'string' && <Button onPress={() => { void task.run(() => copyText(`${__API_BASE__}/room/invite/${tap.getStorageSync(`jev.invite.${id}`)}`)); }}>{t('复制邀请链接', 'Copy invitation')}</Button>}
        {canShare() && typeof tap.getStorageSync(`jev.invite.${id}`) === 'string' && <Button onPress={() => { void task.run(() => shareInvite('room', String(tap.getStorageSync(`jev.invite.${id}`)))); }}>{t('邀请 TapTap 好友', 'Invite TapTap friends')}</Button>}
      </View>}
      {local?.pending.filter((item) => !['ask', 'solve', 'discussion'].includes(item.input.type) && item.status !== 'sent').map((item) => <Card key={item.input.clientRequestId}><Text>{t('房间操作', 'Room action')}</Text><Text muted>{item.error ?? t('正在发送…', 'Sending…')}</Text>{item.status === 'confirming' && <Button disabled={!ready} onPress={() => { void task.run(() => outbox.retry(item)); }}>{t('确认发送结果', 'Check result')}</Button>}</Card>)}
      <SectionTitle>{t('玩家', 'Players')}</SectionTitle>{state.members.map((member) => <Card key={member.userId} style={{ padding: 13 }}><Text>{`${member.nickname}${member.isHost ? t(' · 房主', ' · Owner') : ''}${member.isUserHost ? t(' · 主持人', ' · Host') : ''}`}</Text>
        {host && !member.isHost && state.roomStatus === 'playing' && <Button disabled={!ready} danger onPress={() => { void command('kick', { userId: member.userId }); }}>{t('移出玩家', 'Remove player')}</Button>}
        {host && member.isUserHost && <Button disabled={!ready} onPress={() => { void command('revoke_host', { userId: member.userId }); }}>{t('撤销主持', 'Revoke host')}</Button>}
      </Card>)}
      {state.roomStatus === 'playing' && <Button disabled={!ready} onPress={() => { void command(userHost ? 'resign_host' : 'request_host'); }}>{userHost ? t('退出主持', 'Stop hosting') : t('申请主持', 'Request to host')}</Button>}
      {host && state.hostRequests.map((item) => <Card key={item.userId}><Text>{item.nickname}</Text><Row><Button disabled={!ready} onPress={() => { void command('approve_host', { userId: item.userId }); }}>{t('同意主持', 'Approve host')}</Button><Button disabled={!ready} onPress={() => { void command('reject_host', { userId: item.userId }); }}>{t('拒绝', 'Decline')}</Button></Row></Card>)}
      {canRateRoomPuzzle(round.status) && <Rating puzzleId={round.puzzleId} />}
      {state.roomStatus === 'playing' && <Button danger disabled={!ready} onPress={() => { void task.run(async () => { if (!await confirm(t('离开房间', 'Leave room'), t('确定离开当前房间吗？', 'Leave this room?'))) return; const result = await outbox.submit({ type: 'leave', roundId: round.roundId, expectedControlVersion: state.controlVersion, payload: {} }); if (result) go({ page: 'home' }, true); }); }}>{t('离开房间', 'Leave room')}</Button>}
    </View>}
  </View>;
}
