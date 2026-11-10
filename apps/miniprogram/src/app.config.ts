/**
 * 路由表：主包放首页/登录/我的/设置/题库/单人等高频页；
 * 多人、社交、创作三块按需下载（分包），保证主包不超微信 2MB 上限。
 */
export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/login/login',
    'pages/me/me',
    'pages/settings/settings',
    'pages/privacy/privacy',
    'pages/library/library',
    'pages/solo/solo'
  ],
  subPackages: [
    {
      // 多人：会客厅 / 房间 / 邀请落地 / 大厅
      root: 'pkg-room',
      pages: ['pages/lobby/lobby', 'pages/room/room', 'pages/invite/invite', 'pages/hall/hall']
    },
    {
      // 社交：好友 / 私聊 / 通知中心
      root: 'pkg-social',
      pages: ['pages/friends/friends', 'pages/chat/chat', 'pages/notifications/notifications']
    },
    {
      // 创作：作品列表 / 编辑器 / 预览私测
      root: 'pkg-creation',
      pages: ['pages/list/list', 'pages/editor/editor', 'pages/preview/preview']
    }
  ],
  window: {
    navigationBarBackgroundColor: '#0a1522',
    navigationBarTitleText: '超好玩海龟汤',
    navigationBarTextStyle: 'white',
    backgroundColor: '#010b18',
    backgroundTextStyle: 'dark'
  }
})
