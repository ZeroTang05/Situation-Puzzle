/**
 * 定向探针：题库卡片「单人」按钮 → solo 页跳转验证（E2E solo 模块失败的定点复测）。
 * 用法：node scripts/mp-probe-solo.mjs（需 IDE 已开 auto 端口）
 */
import miniProgram from 'miniprogram-automator'

const mini = await miniProgram.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
mini.on('console', (msg) => { if (msg.type === 'error' || msg.type === 'warn') console.log(`[console.${msg.type}]`, msg.args?.map(String).join(' ').slice(0, 200)) })

await mini.reLaunch('/pages/library/library')
await new Promise((r) => setTimeout(r, 5000))

const page = await mini.currentPage()
console.log('path =', page?.path)
const cards = await page.$$('.puzzle-card')
console.log('卡片数 =', cards.length)
if (!cards.length) { console.log('题库没渲染，退出'); await mini.disconnect(); process.exit(1) }

// 第一个卡片的主按钮（.btn-primary）文案与点击
const firstCard = cards[0]
const primary = await firstCard.$('.btn-primary')
console.log('主按钮文案 =', primary ? await primary.text() : '(无)')
await primary.tap()
await new Promise((r) => setTimeout(r, 2500))

const after = await mini.currentPage()
console.log('点击后 path =', after?.path)
console.log(after?.path.includes('solo') ? '跳转 solo ✓' : '跳转 solo ✗')
await mini.disconnect()
