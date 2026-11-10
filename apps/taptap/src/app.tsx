/** 游戏页面入口：隐私同意前不发网络请求；账号功能统一检查真实会话。 */
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { BRAND_NAME } from '@jev/i18n';
import { api } from './api.js';
import { NavigationProvider, SessionProvider, useEndpoint, useNavigation, useSession, type Route } from './state.js';
import { onHide, onShow, useLanguage } from './runtime.js';
import { Button, Card, Row, Scroll, Text, View } from './ui/components.js';
import { Home, Library, Solo } from './pages/catalog.js';
import { Login, Me, Privacy, Settings } from './pages/account.js';
import { Chat, Friends, Notifications } from './pages/social.js';
import { Hall, Invite, Lobby, LobbyLauncher, Room } from './pages/rooms.js';
import { CreationEditor, CreationPreview, Creations } from './pages/creations.js';
import { parseShareScene } from './share-scene.js';
import { useReferralClaim } from './use-referral.js';

const PRIVACY_KEY = 'jev.taptap.privacy.2026-11-10';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 2000 } } });

/** 分享冷启动和热启动都使用同一份场景解析，房间邀请与会客厅邀请分开。 */
function launchRoute(options: TapLaunchOptions): Route | null {
  const data = parseShareScene(options);
  return data && data.kind !== 'referral' ? { page: 'invite', ...data } : null;
}

function Screen({ route }: { route: Route }) {
  switch (route.page) {
    case 'home': return <Home />;
    case 'library': return <Library {...(route.pick && { pick: route.pick })} />;
    case 'solo': return <Solo id={route.id} {...(route.language && { puzzleLanguage: route.language })} />;
    case 'login': return <Login {...(route.next && { next: route.next })} />;
    case 'hall': return <Hall />;
    case 'open-lobby': return <LobbyLauncher {...(route.puzzleId && { puzzleId: route.puzzleId })} {...(route.language && { language: route.language })} />;
    case 'lobby': return <Lobby id={route.id} />;
    case 'room': return <Room id={route.id} />;
    case 'invite': return <Invite kind={route.kind} token={route.token} />;
    case 'me': return <Me />;
    case 'settings': return <Settings />;
    case 'friends': return <Friends />;
    case 'chat': return <Chat id={route.id} />;
    case 'notifications': return <Notifications />;
    case 'creations': return <Creations />;
    case 'editor': return <CreationEditor id={route.id} />;
    case 'preview': return <CreationPreview id={route.id} />;
    case 'privacy': return <Privacy />;
  }
}

function GameShell() {
  const { route, go, back, scrollKey } = useNavigation(); const { session, loading, error, refresh } = useSession(); const { t } = useLanguage();
  const referral = useReferralClaim();
  const notifications = useEndpoint<{ unread: number }>('/notifications/unread-count', { enabled: Boolean(session), interval: 10_000 });
  useEffect(() => {
    const receive = (options: TapLaunchOptions) => {
      const scene = parseShareScene(options);
      if (scene?.kind === 'referral') referral.remember(scene.code);
      else { const next = launchRoute(options); if (next) go(next); }
    };
    const initial = parseShareScene(tap.getLaunchOptionsSync());
    if (initial?.kind === 'referral') referral.remember(initial.code);
    return onShow(receive);
  }, [referral.remember]);
  const publicPage = ['home', 'library', 'solo', 'login', 'privacy'].includes(route.page);
  const identity = 'id' in route ? route.id : route.page === 'invite' ? `${route.kind}:${route.token}` : JSON.stringify(route);
  return <View style={{ flex: 1 }}>
    <View style={{ padding: 12 }}><Text size={20}>{BRAND_NAME}</Text><Row>
      {route.page !== 'home' && <Button onPress={back}>{t('返回', 'Back')}</Button>}
      {session && <Button onPress={() => go({ page: 'notifications' })}>{`${t('通知', 'Notifications')}${notifications.data?.unread ? ` (${notifications.data.unread})` : ''}`}</Button>}
    </Row></View>
    <Scroll key={`${route.page}:${identity}`} scrollKey={scrollKey} autoBottom={route.page === 'solo' || route.page === 'preview' || route.page === 'room' || route.page === 'chat'}>
      <View style={{ padding: 16 }}>
        {referral.error && <Card><Text>{t('好友邀请确认失败', 'Referral could not be confirmed')}</Text><Text>{referral.error}</Text><Row><Button disabled={referral.busy} onPress={referral.retry}>{t('重试', 'Retry')}</Button><Button onPress={referral.dismiss}>{t('关闭', 'Dismiss')}</Button></Row></Card>}
        {!publicPage && loading ? <Text muted>{t('正在读取账号…', 'Loading account…')}</Text> : !publicPage && error ? <Card><Text>{error.message}</Text><Button onPress={() => { void refresh().catch((error) => console.error('[taptap:session]', error)); }}>{t('重试', 'Retry')}</Button></Card>
          : !publicPage && !session ? <Login next={route} /> : <Screen route={route} />}
      </View>
    </Scroll>
    <View style={{ padding: 10 }}><Row><View style={{ flex: 1, marginRight: 8 }}><Button onPress={() => go({ page: 'home' }, true)}>{t('首页', 'Home')}</Button></View><View style={{ flex: 1 }}><Button onPress={() => go({ page: 'me' }, true)}>{t('我的', 'Me')}</Button></View></Row></View>
  </View>;
}

export function App() {
  const { t } = useLanguage(); const [consented, setConsented] = useState(() => tap.getStorageSync(PRIVACY_KEY) === true);
  useEffect(() => {
    const stopShow = onShow(() => focusManager.setFocused(true)); const stopHide = onHide(() => focusManager.setFocused(false));
    const network = ({ isConnected }: { isConnected: boolean }) => onlineManager.setOnline(isConnected);
    tap.onNetworkStatusChange(network);
    return () => { stopShow(); stopHide(); tap.offNetworkStatusChange(network); };
  }, []);
  if (!consented) return <View style={{ flex: 1, padding: 20 }}><Scroll><Text size={28}>{BRAND_NAME}</Text><Privacy /></Scroll><Button primary onPress={() => { tap.setStorageSync(PRIVACY_KEY, true); setConsented(true); }}>{t('同意并开始', 'Agree and play')}</Button></View>;
  return <QueryClientProvider client={client}><NavigationProvider initial={launchRoute(tap.getLaunchOptionsSync()) ?? { page: 'home' }}><SessionProvider><GameShell /></SessionProvider></NavigationProvider></QueryClientProvider>;
}
