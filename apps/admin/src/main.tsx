import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Admin, Resource, ListGuesser } from 'react-admin';
import { authProvider } from './auth-provider.js';
import { dataProvider } from './data-provider.js';
import { PuzzleList, VersionDetail } from './puzzles.js';
import { UserList, RoomList, ReportList, OrderList, Dashboard } from './resources.js';
import { AdminLoginRedirect } from './admin-login-redirect.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin
      authProvider={authProvider}
      dataProvider={dataProvider}
      dashboard={Dashboard}
      // 用我们自己的 Redirect 替掉 React-Admin 自带的 Username/Password 表单，
      // 让 admin 复用 web 端登录入口（EmailOTP / 密码 / Google），共用 cookie。
      loginPage={AdminLoginRedirect}
      requireAuth
    >
      <Resource name="puzzles" list={PuzzleList} show={VersionDetail} recordRepresentation="title" options={{ label: '题库与投稿' }} />
      <Resource name="users" list={UserList} recordRepresentation="nickname" options={{ label: '用户' }} />
      <Resource name="rooms" list={RoomList} recordRepresentation="roomId" options={{ label: '房间' }} />
      <Resource name="reports" list={ReportList} recordRepresentation="reason" options={{ label: '举报' }} />
      <Resource name="orders" list={OrderList} recordRepresentation="orderId" options={{ label: '订单' }} />
      <Resource name="overview" list={ListGuesser} options={{ label: '总览' }} />
    </Admin>
  </StrictMode>,
);
