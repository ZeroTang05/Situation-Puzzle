import { DialogProvider } from '@jev/ui';
import '@jev/ui/dialog.css';
import { t } from '@jev/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Admin, Resource, ListGuesser } from 'react-admin';
import { authProvider } from './auth-provider.js';
import { dataProvider } from './data-provider.js';
import { PuzzleList, VersionDetail } from './puzzles.js';
import { UserList, RoomList, ReportList, OrderList, Dashboard, LangSwitch } from './resources.js';
import { AdminLoginRedirect } from './admin-login-redirect.js';
import { LanguageProvider, useLanguage } from './language.js';
import { copy } from './copy.js';

function AdminShell() {
  const { language } = useLanguage();
  const c = copy(language);
  return (
    <Admin
      authProvider={authProvider}
      dataProvider={dataProvider}
      dashboard={Dashboard}
      // 用我们自己的 Redirect 替掉 React-Admin 自带的 Username/Password 表单，
      // 让 admin 复用 web 端登录入口（EmailOTP / 密码 / Google），共用 cookie。
      loginPage={AdminLoginRedirect}
      requireAuth
    >
      <Resource name="puzzles" list={PuzzleList} show={VersionDetail} recordRepresentation="title" options={{ label: c.menuPuzzles }} />
      <Resource name="users" list={UserList} recordRepresentation="nickname" options={{ label: c.menuUsers }} />
      <Resource name="rooms" list={RoomList} recordRepresentation="roomId" options={{ label: c.menuRooms }} />
      <Resource name="reports" list={ReportList} recordRepresentation="reason" options={{ label: c.menuReports }} />
      <Resource name="orders" list={OrderList} recordRepresentation="orderId" options={{ label: c.menuOrders }} />
      <Resource name="overview" list={ListGuesser} options={{ label: c.menuOverview }} />
    </Admin>
  );
}

function AdminDialogs() {
  const { language } = useLanguage();
  const labels = t(language);
  return <DialogProvider confirmLabel={labels.confirm} cancelLabel={labels.cancel}><AdminShell /><LangSwitch /></DialogProvider>;
}

function App() {
  return (
    <LanguageProvider>
      <AdminDialogs />
    </LanguageProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);