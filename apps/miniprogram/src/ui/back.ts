/**
 * 返回按钮（对齐 apps/web/src/back.ts 的 useBack(fallback)）：
 * 页面栈里有上一页就返回；从分享卡片/通知直达、栈里只有本页时，
 * 回到兜底页（默认首页），不让用户卡在没有出口的页面。
 */
import Taro from '@tarojs/taro'

export function goBack(fallback = '/pages/index/index'): void {
  if (Taro.getCurrentPages().length > 1) {
    void Taro.navigateBack()
    return
  }
  void Taro.reLaunch({ url: fallback })
}
