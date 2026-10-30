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
  window: {
    navigationBarBackgroundColor: '#0a1522',
    navigationBarTitleText: 'AI 海龟汤',
    navigationBarTextStyle: 'white',
    backgroundColor: '#010b18',
    backgroundTextStyle: 'dark'
  }
})
