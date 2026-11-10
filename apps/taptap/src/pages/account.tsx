/** 账号、设置、邮箱认证与隐私页面。TapTap 与网页账号通过明确关联共用数据。 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { displayAuthError } from '@jev/i18n';
import { meResponseSchema, miniLoginResponseSchema, inviteClaimRequestSchema } from '@jev/contracts';
import { api, authRequest, login, platformCode, signOut, storeToken, ApiError } from '../api.js';
import { clearRoomLocal } from '../rooms/room-local.js';
import { confirm, copyText, setLanguage, useLanguage } from '../runtime.js';
import { useEndpoint, useNavigation, useSession, useTask, Status, TaskStatus, type Route } from '../state.js';
import { Button, Card, Choice, Input, Text, View } from '../ui/components.js';
import { DeviceLogin } from '../device-login.js';
import { otpSendResponseSchema } from '../auth-protocol.js';
import { canShare, shareReferral } from '../share.js';

interface History { hasMore: boolean; rooms: Array<{ roomId: string; roomStatus: string; createdAt: string; rounds: Array<{ roundId: string; title: string | null; status: string }> }> }

export function Me() {
  const { t } = useLanguage(); const { go } = useNavigation(); const task = useTask();
  const me = useEndpoint<z.infer<typeof meResponseSchema>>('/me'); const [page, setPage] = useState(1);
  const history = useEndpoint<History>(`/me/history?page=${page}&limit=5`);
  return <View><Status query={me} />{me.data && <Card><Text size={24}>{me.data.nickname}</Text><Text muted>{me.data.email}</Text>
    <Text>{me.data.betaOpen ? t('内测畅玩', 'Unlimited beta play') : `${t('可用开房次数', 'Available rooms')}：${me.data.freeRooms.total - me.data.freeRooms.consumed - me.data.freeRooms.reserved}`}</Text>
    <Text>{me.data.sponsorship.lifetime ? t('永久赞助', 'Lifetime supporter') : me.data.sponsorship.monthlyUntil ? `${t('赞助到期', 'Supporter until')}：${me.data.sponsorship.monthlyUntil.slice(0, 10)}` : t('免费账号', 'Free account')}</Text>
    <Button onPress={() => go({ page: 'settings' })}>{t('设置', 'Settings')}</Button>
    <Text>{`${t('已邀请好友', 'Friends invited')}：${me.data.invite.invitedCount}`}</Text>
    {canShare() && <Button disabled={task.busy} onPress={() => { void task.run(() => shareReferral(me.data!.invite.code)); }}>{t('邀请好友', 'Invite friends')}</Button>}
    <Button disabled={task.busy} onPress={() => { void task.run(() => copyText(`${__API_BASE__}/?ref=${me.data!.invite.code}`)); }}>{t('复制好友邀请链接', 'Copy referral link')}</Button>
    <Button disabled={task.busy} onPress={() => { void task.run(() => copyText(me.data!.email)); }}>{t('复制我的邮箱', 'Copy my email')}</Button>
  </Card>}
    <TaskStatus task={task} /><Button onPress={() => go({ page: 'friends' })}>{t('好友', 'Friends')}</Button><Button onPress={() => go({ page: 'notifications' })}>{t('通知中心', 'Notifications')}</Button>
    <Text size={21}>{t('多人历史', 'Multiplayer history')}</Text><Status query={history} />
    {history.data?.rooms.map((room) => <Card key={room.roomId}><Text>{room.rounds.map((round) => round.title).filter(Boolean).join(' · ') || t('房间', 'Room')}</Text><Text muted>{new Date(room.createdAt).toLocaleString()}</Text>
      <Button onPress={() => go({ page: 'room', id: room.roomId })}>{room.roomStatus === 'playing' ? t('返回房间', 'Return to room') : t('查看记录', 'View game')}</Button>
    </Card>)}
    <Button disabled={page <= 1} onPress={() => setPage(page - 1)}>{t('上一页', 'Previous')}</Button><Button disabled={!history.data?.hasMore} onPress={() => setPage(page + 1)}>{t('下一页', 'Next')}</Button>
  </View>;
}

export function Settings() {
  const { language, t } = useLanguage(); const { go } = useNavigation(); const client = useQueryClient(); const session = useSession(); const task = useTask();
  const me = useEndpoint<z.infer<typeof meResponseSchema>>('/me'); const [nickname, setNickname] = useState(''); const [redeem, setRedeem] = useState(''); const [invitation, setInvitation] = useState('');
  return <View><Status query={me} />
    <Input label={t('昵称', 'Nickname')} value={nickname} placeholder={me.data?.nickname ?? ''} maxLength={30} onChange={setNickname} />
    <Button disabled={task.busy || !nickname.trim()} onPress={() => { void task.run(async () => { await api('/me/nickname', { method: 'PATCH', body: { nickname: nickname.trim() } }); await session.refresh(); }); }}>{t('保存昵称', 'Save nickname')}</Button>
    <Choice value={language} options={[[ 'zh', '中文' ], [ 'en', 'English' ]]} onChange={setLanguage} />
    <Input label={t('兑换码', 'Redeem code')} value={redeem} onChange={setRedeem} maxLength={64} />
    <Button disabled={task.busy || !redeem.trim()} onPress={() => { void task.run(async () => { await api('/orders/redeem', { body: { code: redeem.trim() } }); setRedeem(''); await me.refetch(); }); }}>{t('兑换', 'Redeem')}</Button>
    <Input label={t('好友邀请码', 'Referral code')} value={invitation} onChange={setInvitation} maxLength={8} />
    <Button disabled={task.busy || !invitation.trim()} onPress={() => { void task.run(async () => { await api('/invites/claim', { body: inviteClaimRequestSchema.parse({ code: invitation.trim().toUpperCase() }) }); setInvitation(''); }); }}>{t('确认邀请人', 'Confirm referral')}</Button>
    <Button disabled={task.busy} onPress={() => { void task.run(async () => { await authRequest('/taptap-mini/link', { body: { code: await platformCode() } }, z.object({ success: z.boolean() })); }); }}>{t('关联当前 TapTap 账号', 'Link this TapTap account')}</Button>
    <TaskStatus task={task} /><Button onPress={() => go({ page: 'privacy' })}>{t('隐私政策', 'Privacy policy')}</Button>
    <Button danger disabled={task.busy} onPress={() => { void task.run(async () => {
      if (!await confirm(t('退出登录', 'Sign out'), t('确定退出当前账号吗？', 'Sign out of this account?'))) return;
      await signOut(); if (session.session) await clearRoomLocal(session.session.user.id);
      client.setQueryData(['session'], null); client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' }); go({ page: 'home' }, true);
    }); }}>{t('退出登录', 'Sign out')}</Button>
  </View>;
}

/** 邮箱注册沿用验证码闸门；TapTap 登录由官方临时 code 交换站内令牌。 */
export function Login({ next = { page: 'me' } }: { next?: Route }) {
  const { language, t } = useLanguage(); const { go } = useNavigation(); const session = useSession(); const client = useQueryClient(); const task = useTask();
  const [mode, setMode] = useState<'password' | 'otp' | 'signup' | 'reset'>('password');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [otp, setOtp] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [waitUntil, setWaitUntil] = useState(() => Number(tap.getStorageSync('jev.taptap.otp.until') || 0)); const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState(''); const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const [deviceActive, setDeviceActive] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const finish = async () => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    const current = await session.refresh();
    if (!current) throw new Error(t('登录状态未能确认，请重新登录。', 'The sign-in session could not be confirmed. Please sign in again.'));
    go(next, true);
  };
  const rememberWait = (seconds: number) => { const until = seconds ? Date.now() + seconds * 1000 : 0; setWaitUntil(until); tap.setStorageSync('jev.taptap.otp.until', until); setNow(Date.now()); };
  const address = () => { const parsed = z.email().safeParse(email.trim().toLowerCase()); if (!parsed.success) throw new Error(displayAuthError('INVALID_EMAIL', language, '')); return parsed.data; };
  const sendCode = () => task.run(async () => {
    if (Date.now() < waitUntil) return;
    const emailAddress = address(); rememberWait(60);
    try {
      const result = await authRequest(mode === 'reset' ? '/email-otp/request-password-reset' : '/email-otp/send-verification-otp', {
        body: mode === 'reset' ? { email: emailAddress } : { email: emailAddress, type: 'sign-in' },
        ...(mode === 'signup' && { headers: { 'x-jev-otp-purpose': 'signup' } }),
      }, otpSendResponseSchema);
      rememberWait(result.retryAfterSeconds);
      setNotice(mode === 'reset' ? t('如果该邮箱已注册，验证码会发送到邮箱。', 'If this email is registered, a code will be sent to it.') : t('验证码已发送，请查看邮箱。', 'Code sent. Check your email.'));
    } catch (error) {
      if (error instanceof ApiError && error.status !== 0) rememberWait(error.retryAfterSeconds ?? 0);
      throw error;
    }
  });
  const submit = () => task.run(async () => {
    const emailAddress = address();
    if (mode !== 'otp' && password.length < 8) throw new Error(displayAuthError('INVALID_PASSWORD', language, ''));
    if (mode !== 'password' && !/^\d{6}$/.test(otp)) throw new Error(displayAuthError('INVALID_OTP', language, ''));
    if (mode === 'reset') {
      if (password !== confirmation) throw new Error(t('两次输入的密码不一致。', 'The passwords do not match.'));
      await authRequest('/email-otp/reset-password', { body: { email: emailAddress, otp, password } }, z.object({ success: z.boolean() }));
      setMode('password'); setOtp(''); setPassword(''); setConfirmation(''); setNotice(t('密码已更新，请重新登录。', 'Password updated. Please sign in.')); return;
    }
    if (mode === 'signup') {
      const registered = await authRequest('/sign-up/email', { body: { email: emailAddress, password, name: name.trim() }, headers: { 'x-jev-signup-otp': otp } }, miniLoginResponseSchema);
      storeToken(registered.token); await finish(); return;
    }
    const result = await authRequest(mode === 'otp' ? '/sign-in/email-otp' : '/sign-in/email', { body: mode === 'otp' ? { email: emailAddress, otp } : { email: emailAddress, password } }, miniLoginResponseSchema);
    storeToken(result.token); await finish();
  });
  return <View><Button primary disabled={task.busy || deviceActive} onPress={() => { void task.run(async () => { await login(); await finish(); }); }}>{t('TapTap 一键登录', 'Sign in with TapTap')}</Button>
    <DeviceLogin disabled={task.busy} onSuccess={finish} onActiveChange={setDeviceActive} />
    <Choice disabled={task.busy || deviceActive} value={language} options={[[ 'zh', '中文' ], [ 'en', 'English' ]]} onChange={setLanguage} />
    <Choice disabled={task.busy || deviceActive} value={mode} options={[[ 'password', t('密码登录', 'Password') ], [ 'otp', t('验证码登录', 'Email code') ], [ 'signup', t('注册', 'Sign up') ], [ 'reset', t('找回密码', 'Reset password') ]]} onChange={(value) => { setMode(value); setNotice(''); task.clear(); }} />
    {mode === 'signup' && <Input disabled={task.busy || deviceActive} label={t('昵称（可选）', 'Nickname (optional)')} value={name} onChange={setName} maxLength={30} />}
    <Input disabled={task.busy || deviceActive} label={t('邮箱', 'Email')} value={email} onChange={setEmail} maxLength={254} />
    {mode !== 'password' && <View><Button disabled={task.busy || deviceActive || wait > 0 || !email.trim()} onPress={() => { void sendCode(); }}>{wait > 0 ? `${wait}s` : t('发送验证码', 'Send code')}</Button><Input disabled={task.busy || deviceActive} label={t('验证码', 'Code')} value={otp} onChange={setOtp} maxLength={6} /></View>}
    {mode !== 'otp' && <Input disabled={task.busy || deviceActive} label={t('密码（至少 8 位）', 'Password (8+ characters)')} value={password} onChange={setPassword} maxLength={128} password />}
    {mode === 'reset' && <Input disabled={task.busy || deviceActive} label={t('再次输入新密码', 'Confirm new password')} value={confirmation} onChange={setConfirmation} maxLength={128} password />}
    {notice && <Text>{notice}</Text>}<TaskStatus task={task} /><Button primary disabled={task.busy || deviceActive || !email.trim()} onPress={() => { void submit(); }}>{mode === 'signup' ? t('注册并登录', 'Create account') : mode === 'reset' ? t('更新密码', 'Update password') : t('登录', 'Sign in')}</Button>
  </View>;
}

export function Privacy() {
  const { t } = useLanguage();
  return <View><Text size={24}>{t('隐私政策', 'Privacy policy')}</Text>
    <Text>{t('单人对话、草稿和游玩记录保存在当前小游戏本地。判题时，题目、问题或还原内容及必要的最近问答会发送给服务器和 AI 判题服务处理。单人对话不写入业务数据库。', 'Solo conversations, drafts and progress are stored on this device. Puzzles, questions, solutions and necessary recent questions are sent to our server and AI providers for judging. Solo conversations are not stored in business tables.')}</Text>
    <Text>{t('登录后，账号、多人对局、好友关系、私聊、通知和创作会保存到服务器，用于提供对应功能。TapTap 登录时，我们使用平台的账号标识建立站内账号；平台应用密钥和会话密钥不会发送到游戏客户端。', 'Account data, multiplayer games, friends, messages, notifications and creations are stored on our server to provide these features. TapTap identifiers create an in-game account. Platform secrets and session keys are never sent to the client.')}</Text>
    <Text>{t('你可以在设置中修改昵称、退出登录；清理小游戏数据会删除本地记录。隐私咨询或账号数据删除请求请联系 support@xiaobaozi.cn。', 'You can edit your nickname and sign out in Settings. Clearing game data removes local records. Contact support@xiaobaozi.cn for privacy or account deletion requests.')}</Text>
    <Text muted>support@xiaobaozi.cn</Text>
  </View>;
}
