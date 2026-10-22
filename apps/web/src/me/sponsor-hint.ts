/**
 * 支付二维码的提示选择。
 *
 * 微信 Native 是「PC 网页亮码、微信 App 扫码」的形态：手机上打开这个页面时，
 * 二维码就在自己屏幕上，没法扫——官方也不允许「相册识别 / 长按识别」这条路。
 * 所以窄屏且通道只能出二维码时，提示改成「请用电脑扫码」。
 *
 * 有跳转链接的通道（支付宝电脑网站支付 ALIPAY_PRODUCT=page）在手机上照常可用，
 * 提示保持原样。
 */
export function narrowScanHint(narrow: boolean, hasPayUrl: boolean): boolean {
  return narrow && !hasPayUrl;
}
