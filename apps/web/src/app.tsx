/** 路由结构：单人 / 题库 / 房间 / 邀请 / 我的 / 登录。 */
import { Navigate, Route, Routes } from 'react-router';
import { HomePage } from './lobby/home-page.js';
import { LibraryPage } from './catalog/library-page.js';
import { SoloPage } from './solo/solo-page.js';
import { RoomPage } from './rooms/room-page.js';
import { InvitePage } from './rooms/invite-page.js';
import { MePage } from './me/me-page.js';
import { LoginPage } from './auth/login-page.js';
import { useSession } from './api/auth-client.js';

export function App() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <div className="page-loading">加载中…</div>;
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage session={session ?? null} />} />
      <Route path="/library" element={<LibraryPage session={session ?? null} />} />
      <Route path="/solo/:puzzleId" element={<SoloPage session={session ?? null} />} />
      <Route path="/rooms/:roomId" element={<RoomPage session={session ?? null} />} />
      <Route path="/invite/:token" element={<InvitePage session={session ?? null} />} />
      <Route path="/me" element={<MePage session={session ?? null} />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
