/** 路由结构：单人 / 题库 / 房间 / 邀请 / 创作中心 / 我的 / 登录。 */
import { Navigate, Route, Routes } from 'react-router';
import { HomePage } from './lobby/home-page.js';
import { LibraryPage } from './catalog/library-page.js';
import { SoloPage } from './solo/solo-page.js';
import { RoomPage } from './rooms/room-page.js';
import { LobbyPage } from './rooms/lobby-page.js';
import { InvitePage } from './rooms/invite-page.js';
import { MePage } from './me/me-page.js';
import { LoginPage } from './auth/login-page.js';
import { ForgotPasswordPage } from './auth/forgot-password-page.js';
import { ResetPasswordPage } from './auth/reset-password-page.js';
import { useJevSession } from './api/auth-client.js';
import { CreationListPage } from './creations/creation-list-page.js';
import { CreationEditorPage } from './creations/creation-editor-page.js';
import { CreationPreviewPage } from './creations/creation-preview-page.js';

export function App() {
  const { session, isPending } = useJevSession();

  if (isPending) {
    return <div className="page-loading">加载中…</div>;
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage session={session} />} />
      <Route path="/library" element={<LibraryPage session={session} />} />
      <Route path="/solo/:puzzleId" element={<SoloPage session={session} />} />
      <Route path="/rooms/:roomId" element={<RoomPage session={session} />} />
      <Route path="/lobbies/:lobbyId" element={<LobbyPage session={session} />} />
      <Route path="/lobby/invite/:token" element={<InvitePage kind="lobby" session={session} />} />
      <Route path="/room/invite/:token" element={<InvitePage kind="room" session={session} />} />
      <Route path="/me" element={<MePage session={session} />} />
      <Route path="/creations" element={<CreationListPage session={session} />} />
      <Route path="/creations/new" element={<CreationEditorPage session={session} />} />
      <Route path="/creations/:puzzleId" element={<CreationEditorPage session={session} />} />
      <Route path="/creations/:puzzleId/preview" element={<CreationPreviewPage session={session} />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
