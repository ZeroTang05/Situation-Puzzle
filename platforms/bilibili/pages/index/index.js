// 小程序原生层取得一次性 code，网页交给 Worker 换取用户身份。
Page({
  data: { src: '', error: '' },
  onLoad() {
    const webUrl = getApp().globalData.webUrl;
    if (!webUrl) { this.setData({ error: '请先配置网页地址。' }); return; }
    bl.login({
      success: ({ code }) => {
        if (!code) { this.setData({ error: '登录失败，请重新打开小程序。' }); return; }
        const separator = webUrl.includes('?') ? '&' : '?';
        this.setData({ src: `${webUrl}${separator}platform=bilibili&login_code=${encodeURIComponent(code)}` });
      },
      fail: (error) => { console.error(error); this.setData({ error: '登录失败，请重新打开小程序。' }); },
    });
  },
});
