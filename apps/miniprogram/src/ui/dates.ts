/**
 * 日期格式化（替代 toLocale* 系列）。
 *
 * 为什么不用 toLocaleDateString：小程序运行时（iOS JavaScriptCore / 部分 Android）的
 * Intl locale 数据不全，「zh-CN」经常落回英文月份，默认参数还会带出英文星期——
 * 用户报的「中文模式月份是英文」就是它。这里手动拼出与 web 端（Chrome Intl）一致的形状：
 * - 短日期（同年省略年份）：zh 11月14日 / en Nov 14；跨年补年份
 * - 默认日期：zh 2026/11/14 / en 11/14/2026
 * - 完整时间：zh 2026/11/14 20:15:33 / en 11/14/2026, 8:15:33 PM
 * - 气泡时间：zh 20:15 / en 8:15 PM
 */

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** 无效时间串返回空串，交给调用方的空态兜底 */
function safeDate(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 短日期（me 历史行）：同年「11月14日 / Nov 14」，跨年补年份「2025年11月14日 / Nov 14, 2025」 */
export function formatShortDate(iso: string, language: 'zh' | 'en'): string {
  const date = safeDate(iso)
  if (!date) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  if (language === 'zh') {
    const head = sameYear ? '' : `${date.getFullYear()}年`
    return `${head}${date.getMonth() + 1}月${date.getDate()}日`
  }
  const month = EN_MONTHS[date.getMonth()]!
  return sameYear ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`
}

/** 默认日期（无时分秒）：zh 2026/11/14，en 11/14/2026 */
export function formatDefaultDate(iso: string, language: 'zh' | 'en'): string {
  const date = safeDate(iso)
  if (!date) return ''
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  return language === 'zh' ? `${y}/${m}/${d}` : `${m}/${d}/${y}`
}

/** 12 小时制的时间段：en 下午 8:15:33 PM 的形状（web en-US 默认输出） */
function enTime(date: Date, withSeconds: boolean): string {
  const hours24 = date.getHours()
  const meridiem = hours24 < 12 ? 'AM' : 'PM'
  const h12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const tail = withSeconds ? `:${pad2(date.getSeconds())}` : ''
  return `${h12}:${pad2(date.getMinutes())}${tail} ${meridiem}`
}

/** 完整时间（通知/审核时间）：zh 2026/11/14 20:15:33，en 11/14/2026, 8:15:33 PM */
export function formatDateTime(iso: string, language: 'zh' | 'en'): string {
  const date = safeDate(iso)
  if (!date) return ''
  return language === 'zh'
    ? `${formatDefaultDate(iso, 'zh')} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    : `${formatDefaultDate(iso, 'en')}, ${enTime(date, true)}`
}

/** 气泡时间（私聊消息，只到分钟）：zh 20:15，en 8:15 PM */
export function formatTime(iso: string, language: 'zh' | 'en'): string {
  const date = safeDate(iso)
  if (!date) return ''
  return language === 'zh'
    ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    : enTime(date, false)
}
