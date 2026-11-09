/**
 * 定向探针：进题库页 dump 元素计数与文本摘要（判「空数据 / 加载中 / 报错 / 白壳」）。
 * automator 0.13 的 Page 没有 wxml()，用元素查询拼证据。
 * 用法：node scripts/mp-probe-library.mjs（需 IDE 已开 auto 端口）
 */
import miniProgram from 'miniprogram-automator'

const mini = await miniProgram.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

const logs = []
mini.on('console', (msg) => logs.push(`[${msg.type}] ${msg.args?.map((a) => String(a?.toString?.() ?? a)).join(' ')}`))
mini.on('exception', (err) => logs.push(`[exception] ${err.message} ${err.stack ?? ''}`))

await mini.reLaunch('/pages/library/library')
await new Promise((r) => setTimeout(r, 6000))

const page = await mini.currentPage()
console.log('path =', page?.path)
// 元素计数：页面结构层级逐级看
for (const sel of ['view', '.page', '.filter-bar', '.puzzle-grid', '.puzzle-card', '.muted', '.error-text', 'button', '.btn']) {
  try {
    const els = await page.$$(sel)
    console.log(`${sel} × ${els.length}`)
  } catch (e) {
    console.log(`${sel} 查询失败: ${e.message}`)
  }
}
// 拼前几个 view 的文本（截断）
try {
  const views = await page.$$('view')
  let text = ''
  for (const v of views.slice(0, 60)) {
    text += ((await v.text()) ?? '') + ' | '
    if (text.length > 400) break
  }
  console.log('文本摘要:', text.slice(0, 400))
} catch (e) {
  console.log('文本抓取失败:', e.message)
}
console.log('--- console（最后 20 条）---')
for (const l of logs.slice(-20)) console.log(l)
await mini.disconnect()
