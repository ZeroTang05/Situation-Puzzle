/**
 * 小程序全功能 E2E（测试工程师模式）：拉起微信开发者工具自动化，逐页逐按钮真点，
 * 每步断言 + 截图，最后输出通过/失败清单与「每页按钮覆盖表」。
 *
 * 用法：node scripts/mp-e2e.mjs <输出目录> [模块 ...]
 *   不带模块 = 全量；模块名：login home library solo lobby room hall friends chat
 *   notifications creations me
 *
 * 前置：微信开发者工具已登录且服务端口可开（复用 mp-screenshot 的拉起逻辑）；
 * 模拟器直连生产接口（client.ts 的 API_BASE），微信一键登录用真实 AppID。
 * 会写生产数据的动作都在本脚本内闭环清理：房间解散、作品撤回+删除、昵称还原。
 */
import { mkdir } from 'node:fs/promises'
import { execSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { default: connectionCtor } = await import(import.meta.resolve('miniprogram-automator/out/Connection.js'))
const { default: miniProgramCtor } = await import(import.meta.resolve('miniprogram-automator/out/MiniProgram.js'))
const Connection = connectionCtor.default ?? connectionCtor
const MiniProgram = miniProgramCtor.default ?? miniProgramCtor

const INSTALL_DIR = 'D:/Program Files (x86)/微信web开发者工具'
const PROJECT_PATH = process.env.MP_PROJECT_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTO_PORT = 9420

/** 拉起开发者工具自动化端口（与 mp-screenshot 同款：cwd 必须是安装目录） */
function launchDevTools() {
  const exe = `${INSTALL_DIR}/微信开发者工具.exe`
  const cli = `${INSTALL_DIR}/resources/app.asar.unpacked/js/common/cli/index.js`
  const bootstrap = `const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});process.env.cwd=process.cwd();process.argv=[process.execPath,'--ms-enable-electron-run-as-node',e,'--electron'].concat(a);require(e)`
  const child = spawn(exe, ['-e', bootstrap, cli, 'auto', '--project', PROJECT_PATH, '--auto-port', String(AUTO_PORT), '--trust-project'], {
    cwd: INSTALL_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.write('y\n')
  return child
}

const outputDir = process.argv[2]
if (!outputDir) {
  console.error('用法：node scripts/mp-e2e.mjs <输出目录> [模块 ...]')
  process.exit(1)
}
await mkdir(outputDir, { recursive: true })
const onlyModules = process.argv.slice(3)

let mini = null
try {
  const connection = await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)
  mini = new MiniProgram(connection)
  console.log('已连上现有自动化会话')
} catch {
  console.log('没有现成会话，拉起开发者工具自动化…')
  const devtools = launchDevTools()
  for (let waited = 0; waited < 120_000 && !mini; waited += 2_000) {
    try {
      const connection = await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)
      mini = new MiniProgram(connection)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  if (!mini) devtools.kill()
}
if (!mini) throw new Error('120 秒内没能连上开发者工具自动化端口')

// 编译窗口内命令无人应答：先轮询到运行时就绪
{
  let ready = false
  for (let waited = 0; waited < 90_000 && !ready; waited += 3_000) {
    try {
      await mini.systemInfo()
      ready = true
    } catch {
      console.log('等待模拟器就绪…')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
  }
  if (!ready) throw new Error('90 秒内模拟器未就绪')
}

// 语言复位为中文：E2E 断言全部按中文文案写，上次运行若把语言切到英文（并持久化），
// 全部按钮断言会集体失配。写回 storage 后 reLaunch 让页面重新读语言。
await mini.callWxMethod('setStorageSync', 'jev.language', 'zh').catch(() => {})

// 转发小程序运行时日志：房间同步/登录失败这类只写 console 的问题直接在测试输出可见
{
  const fmt = (args) => (args ?? []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  mini.on('console', (msg) => {
    const text = fmt(msg.args) ?? ''
    if (msg.type === 'error' || msg.type === 'warn' || text.includes('[room-sync]')) {
      console.log(`[console:${msg.type}] ${text.slice(0, 300)}`)
    }
  })
  mini.on('exception', (err) => console.log(`[exception] ${err.message?.split('\n')[0]}`))
}

// ---------- 断言与工具 ----------
const results = []
/** 每页按钮覆盖表：页面路径 → 已点/未点按钮文案 */
const coverage = new Map()
let currentModule = 'setup'

function check(name, condition, detail = '') {
  results.push({ module: currentModule, name, pass: !!condition, detail })
  console.log(`${condition ? '✓' : '✗'} [${currentModule}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function logBtn(pagePath, text, tapped) {
  if (!coverage.has(pagePath)) coverage.set(pagePath, [])
  const list = coverage.get(pagePath)
  const existing = list.find((row) => row.text === text)
  if (existing) existing.tapped ||= tapped
  else list.push({ text, tapped })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 路径匹配要用完整页路径：'room' 会假阳性命中 'pkg-room' 分包前缀（lobby 也在 pkg-room 里）
const ROOM_PATH = 'pages/room/room'
const LOBBY_PATH = 'pages/lobby/lobby'

/** 截图（失败不致命） */
async function shot(name) {
  try {
    await withTimeout(mini.screenshot({ path: path.join(outputDir, `${name}.png`) }), 15_000, `截图 ${name}`)
  } catch (err) {
    console.log(`截图失败 ${name}: ${err.message}`)
  }
}

/** 所有按钮元素的（去空格）文案 */
async function buttonTexts(page, selector = '.btn') {
  const els = await page.$$(selector)
  const texts = []
  for (const el of els) {
    try {
      texts.push((await el.text()).trim())
    } catch {
      texts.push('')
    }
  }
  return { els, texts }
}

/** 按文案（包含匹配）点按钮；waitMs 为点击后等待。返回是否点到 */
async function tapButton(page, text, { waitMs = 800, selector = '.btn', optional = false, label } = {}) {
  const { els, texts } = await buttonTexts(page, selector)
  const index = texts.findIndex((t) => t.includes(text))
  const pagePath = page.path ?? '?'
  logBtn(pagePath, label ?? text, index >= 0)
  if (index < 0) {
    if (!optional) check(`找到按钮「${text}」`, false, `页面上现有：${texts.filter(Boolean).join(' / ') || '（无按钮）'}`)
    return false
  }
  try {
    await withTimeout(els[index].tap(), 8_000, `点击「${text}」`)
  } catch (err) {
    check(`点击按钮「${text}」`, false, err.message)
    return false
  }
  if (waitMs) await sleep(waitMs)
  return true
}

/** 轮询直到选择器出现（或超时）；返回元素或 null */
async function waitForSelector(page, selector, timeoutMs = 10_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = await page.$(selector)
    if (el) return el
    await sleep(intervalMs)
  }
  return null
}

/** 深海弹窗：确定 */
async function dialogConfirm(page, waitMs = 600) {
  const btn = await waitForSelector(page, '.jev-dialog-confirm', 3_000)
  if (!btn) {
    check('弹窗出现', false)
    return false
  }
  await btn.tap()
  await sleep(waitMs)
  return true
}

/** 输入框赋值：先轮询等输入框挂载（分页/异步渲染期间 $$ 会暂时为空） */
async function fillInput(page, value, selector = 'input', index = 0) {
  let el = null
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !el) {
    const els = await page.$$(selector).catch(() => [])
    el = els[index] ?? null
    if (!el) await sleep(500)
  }
  if (!el) return false
  await el.input(value)
  await sleep(300)
  return true
}

/** 页面是否可见某 class */
async function hasClass(page, selector) {
  return (await page.$(selector)) !== null
}

/** 按文案点任意 text 元素（整行可点的 row、非 .btn 的入口） */
async function tapText(page, text, { waitMs = 800 } = {}) {
  const els = await page.$$('text')
  for (const el of els) {
    try {
      if ((await el.text()).trim().includes(text)) {
        await el.tap()
        if (waitMs) await sleep(waitMs)
        return true
      }
    } catch {}
  }
  return false
}

/** 页面上是否存在含指定文案的 text 元素（只读不点） */
async function textExists(page, text) {
  const els = await page.$$('text').catch(() => [])
  for (const el of els) {
    try {
      if ((await el.text()).trim().includes(text)) return true
    } catch {}
  }
  return false
}

/** automator 偶发不回包：给每个 mini 调用套超时，避免整场测试卡死 */
async function withTimeout(promise, ms, tag) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tag} 超时 ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 带重试的 reLaunch：automator 0.13 的 changeRoute 在页面切换瞬间会因 path undefined 崩（isPluginPath 内部 bug），重试即可 */
async function relaunch(url) {
  // pageUrl 拼出的路径没有前导 /（automator 的 path 不带），reLaunch 会把它当
  // 相对路径拼到当前页路径上（报错形如 pkg-creation/pages/preview/pkg-creation/...），
  // 这里统一补成绝对路径
  if (url && !url.startsWith('/')) url = `/${url}`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await withTimeout(mini.reLaunch(url), 10_000, `reLaunch ${url}`)
      await sleep(400)
      return
    } catch (err) {
      if (attempt === 3) throw err
      await sleep(1_200)
    }
  }
}

/** 页面是否真的渲染出 DOM（IDE 冷启动编译竞态会让页面整页空白：路由在、元素层为空） */
async function pageAlive(page, probe) {
  try {
    if (!page) return false
    if (await page.$(probe ?? 'view')) return true
    if (await page.$('text')) return true
    return false
  } catch {
    return false
  }
}

/** 回到首页（reLaunch 是最可靠的状态复位）；页面必须渲染出 DOM（probe 缺省用 view/text），空白/编译竞态就重试，穷尽后抛错触发 IDE 重启 */
async function goHome(probe) {
  let page = null
  for (let attempt = 0; attempt < 3; attempt++) {
    await relaunch('/pages/index/index')
    page = await waitPath('index/index', 8_000)
    await sleep(600)
    const fresh = await mini.currentPage().catch(() => null)
    // 路径也必须是首页：reLaunch 偶发不生效（room 等实时页离开瞬间），只查渲染会拿残留页当首页
    if (fresh && String(fresh.path ?? '').includes('index/index') && (await pageAlive(fresh, probe))) return fresh
    await sleep(2_000)
  }
  throw new Error('首页反复空白（IDE 编译竞态），需要重启开发者工具')
}

/** 失败现场取证：报出令牌是否还在 storage（只打长度不打印值） */
async function dumpTokenState(tag) {
  try {
    const token = await mini.callWxMethod('getStorageSync', 'jev.mp-session-token')
    console.log(`[token:${tag}] 存在=${Boolean(token)} 长度=${token ? String(token).length : 0}`)
  } catch (err) {
    console.log(`[token:${tag}] 读取失败 ${err.message}`)
  }
}

/** 等首页会话就绪：多人按钮从「开房间（登录）」变成「开房间」 */
async function waitSessionReady(timeoutMs = 20_000) {
  // 冷启动 / 登录后首页可能还显示旧会话态：超时就重进首页再等一轮
  for (let round = 0; round < 2; round++) {
    if (round > 0) await relaunch('/pages/index/index').catch(() => {})
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const page = await withTimeout(mini.currentPage(), 5_000, 'currentPage')
        if (page && page.path && page.path.includes('index/index')) {
          const { texts } = await buttonTexts(page)
          if (texts.some((t) => t.includes('开房间') && !t.includes('登录'))) return true
        }
      } catch {}
      await sleep(600)
    }
  }
  return false
}

/** 轮询当前页面路径直到包含 substr（automator currentPage 在跳转瞬间有竞态） */
async function waitPath(substr, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await withTimeout(mini.currentPage(), 5_000, 'currentPage')
      if (last && last.path && last.path.includes(substr)) return last
    } catch {}
    await sleep(400)
  }
  return last
}

/** Page → 可重进的路由串（path+query）；path 缺失时返回 null */
function pageUrl(p) {
  if (!p || !p.path) return null
  const q = p.query ? Object.entries(p.query).map(([k, v]) => `${k}=${v}`).join('&') : ''
  return q ? `${p.path}?${q}` : p.path
}

/**
 * 返回 = 显式 reLaunch 到目标路由（navigateBack 真实弹栈时偶发卡死 automator 桥，
 * 探针实测 reLaunch 导航全程稳定，e2e 全程绕开 navigateBack）。
 */
async function goBack(expectSubstr, fallbackUrl) {
  const target = expectSubstr ?? 'index/index'
  await relaunch(fallbackUrl ?? '/pages/index/index')
  return await waitPath(target, 10_000)
}

// ---------- 模块 ----------

/** 登出（若已登录）→ 微信一键登录。返回是否拿到会话 */
async function moduleLogin() {
  currentModule = 'login'
  await goHome()
  // 已有会话则先从设置页退出（顺带测退出按钮）；冷启动页面挂载慢，轮询到按钮出现再分流
  await withTimeout(mini.navigateTo('/pages/me/me'), 10_000, 'navigateTo me').catch(() => {})
  await waitPath('/me', 8_000)
  let page = await mini.currentPage()
  let meTexts = []
  for (let i = 0; i < 16; i++) {
    meTexts = (await buttonTexts(page)).texts
    if (meTexts.length > 0) break
    await sleep(700)
    page = await mini.currentPage()
  }
  if (meTexts.some((t) => t.includes('登录'))) {
    // 未登录态的 me 页：直接去登录页
    await tapButton(page, '登录')
  } else {
    await withTimeout(mini.navigateTo('/pages/settings/settings'), 10_000, 'navigateTo settings').catch(() => {})
    await waitPath('settings', 8_000)
    let tapped = false
    for (let i = 0; i < 15; i++) {
      page = await mini.currentPage()
      tapped = await tapButton(page, '退出登录', { optional: true })
      if (tapped) break
      await sleep(800)
    }
    check('设置页出现退出登录按钮', tapped)
    if (tapped) {
      check('退出登录弹窗', await dialogConfirm(page))
      // 退出成功后页面自己 reLaunch 回首页，等它落定再跳登录页，避免两次 reLaunch 赛跑
      await waitPath('index/index', 8_000)
    }
  }
  // 登录页：微信一键登录（同样等按钮挂载）
  await relaunch('/pages/login/login')
  page = await waitPath('login', 10_000)
  for (let i = 0; i < 15; i++) {
    const texts = (await buttonTexts(page)).texts
    if (texts.some((t) => t.includes('微信一键登录'))) break
    await sleep(700)
    page = await mini.currentPage()
  }
  await sleep(600)
  await shot('login-before')
  const tapped = await tapButton(page, '微信')
  if (!tapped) return false
  // 登录请求 + code2session 有网络延迟
  await sleep(4_000)
  page = await mini.currentPage()
  await shot('login-after')
  // 会话强证明：设置页出现「退出登录」按钮
  await relaunch('/pages/settings/settings')
  const settingsPage = await waitPath('settings', 8_000)
  const settingsTexts = (await buttonTexts(settingsPage)).texts
  const loggedIn = settingsTexts.some((t) => t.includes('退出登录'))
  check('微信一键登录拿到会话', loggedIn, loggedIn ? '' : '设置页没有退出登录按钮 = 未登录')
  return loggedIn
}

/** 首页：玩法弹窗、铃铛、各入口、进行中房间行 */
async function moduleHome() {
  currentModule = 'home'
  let page = await goHome('.help-btn')
  await waitSessionReady()
  page = await mini.currentPage()
  await shot('home')
  // ? 玩法介绍
  const help = await page.$('.help-btn')
  check('首页「?」按钮存在', !!help)
  if (help) {
    await help.tap()
    await sleep(600)
    check('玩法介绍弹窗打开', await hasClass(page, '.jev-dialog'))
    await shot('home-intro')
    const close = await page.$('.jev-dialog-cancel')
    if (close) await close.tap()
    await sleep(400)
    check('玩法介绍弹窗关闭', !(await hasClass(page, '.jev-dialog')))
  }
  // 铃铛 → 通知页
  const bell = await page.$('.notification-bell')
  check('首页通知铃铛存在', !!bell)
  if (bell) {
    await bell.tap()
    page = await waitPath('notifications', 8_000)
    check('铃铛进入通知页', !!page && page.path.includes('notifications'))
    await goBack('index/index')
  }
  // 各入口（点进去 → 断言页面 → 返回；守卫入口偶发被会话加载竞态弹去登录页，自动重试一次）
  const entries = [
    ['单人推理', 'library'],
    ['题库', 'library'],
    ['大厅', 'hall'],
    ['我的作品', 'list'],
    ['好友', 'friends'],
    ['我的', '/me'],
    ['开房间', 'lobby'],
  ]
  for (const [text, pathPart] of entries) {
    const optional = text === '我的' || text === '开房间'
    let lastPage = null
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitPath('index/index', 6_000)
      // reLaunch 回首页后会话仍在异步加载：等多人按钮脱离「（登录）」再点受守卫入口，否则被 goAuthed 误弹登录页
      await waitSessionReady(8_000)
      lastPage = await mini.currentPage()
      const tapped = await tapButton(lastPage, text, { optional, waitMs: 500 })
      if (!tapped) break
      lastPage = await waitPath(pathPart, 10_000)
      if (lastPage && lastPage.path?.includes(pathPart)) break
      if (attempt === 0) {
        console.log(`首页「${text}」落到 ${lastPage?.path ?? '未知'}（会话竞态），重试一次`)
        await goHome()
      }
    }
    if (!(lastPage && lastPage.path?.includes(pathPart))) await dumpTokenState(text)
    check(`首页「${text}」进入对应页面`, lastPage && lastPage.path?.includes(pathPart), `path=${lastPage?.path}`)
    if (lastPage && lastPage.path?.includes(pathPart)) {
      await shot(`home-entry-${pathPart === '/me' ? 'me' : pathPart}`)
      await goBack('index/index')
    }
  }
}

/** 题库：筛选、分页、卡片按钮 */
async function moduleLibrary() {
  currentModule = 'library'
  await goHome()
  let page = await mini.currentPage()
  await tapButton(page, '题库')
  await sleep(1_500)
  page = await mini.currentPage()
  const cards0 = (await page.$$('.puzzle-card')).length
  check('题库列表渲染', cards0 > 0, `${cards0} 张卡片`)
  await shot('library')
  // 筛选胶囊逐个点（chips 用的是 .chip 类，不在 .btn 里）
  for (const text of ['最新发布', '最受欢迎', '简单', '适中', '困难', '全部', '本格', '变格']) {
    page = await mini.currentPage()
    const tapped = await tapButton(page, text, { waitMs: 900, optional: true, selector: '.chip' })
    if (tapped) {
      const cards = (await page.$$('.puzzle-card')).length
      check(`筛选「${text}」后列表刷新`, cards >= 0, `${cards} 张卡片`)
    }
  }
  await shot('library-filters')
  // 分页：.library-page-step 顺序 = 上一步（0）/ 下一步（末位）
  page = await mini.currentPage()
  const steps = await page.$$('.library-page-step')
  if (steps.length >= 2) {
    await steps[steps.length - 1].tap()
    await sleep(1_200)
    page = await mini.currentPage()
    const summary = await page.$('.library-pagination-summary')
    const text = summary ? await summary.text() : ''
    check('翻到第 2 页', text.includes('2'), text.trim())
    const stepsBack = await page.$$('.library-page-step')
    await stepsBack[0].tap()
    await sleep(1_200)
  } else {
    check('分页控件存在', false, '没找到翻页按钮（题量不足一页时可接受）')
  }
  // 卡片「单人」按钮 → 单人页（redirectTo，题库出栈）
  page = await mini.currentPage()
  const soloTapped = await tapButton(page, '单人', { waitMs: 500 })
  page = await waitPath('solo', 8_000)
  check('卡片「单人」进入单人页', soloTapped && page && page.path.includes('solo'), `path=${page?.path}`)
  if (soloTapped) {
    await goBack('index/index')
  }
}

/** 单人：提问（真实 Jev）、提示、揭晓、换题 */
async function moduleSolo() {
  currentModule = 'solo'
  await goHome()
  let page = await mini.currentPage()
  await tapButton(page, '单人推理')
  page = await waitPath('library', 8_000)
  if (!page || !page.path.includes('library')) {
    check('进入题库', false, `path=${page?.path}`)
    return
  }
  // 渲染门：题库卡片走生产 API，加载慢时页面只有「返回」，先等卡片再点
  const cardReady = await waitForSelector(page, '.puzzle-card', 15_000, 800)
  check('题库卡片渲染', !!cardReady)
  await tapButton(page, '单人', { waitMs: 500 })
  page = await waitPath('solo', 8_000)
  check('进入单人页', page && page.path.includes('solo'), `path=${page?.path}`)
  await shot('solo')
  // 提示胶囊
  await tapButton(page, '提示', { optional: true, waitMs: 900 })
  // 提问（真实 Jev，最长 ~45s）
  const filled = await fillInput(page, '故事里有人死了吗？', 'textarea')
  check('输入提问', filled)
  const asked = await tapButton(page, '发送', { waitMs: 1_000 })
  check('点击发送提问', asked)
  const verdict = await waitForSelector(page, '.verdict-badge', 90_000, 2_000)
  check('Jev 判定返回', !!verdict)
  await shot('solo-asked')
  // 揭晓答案（soloViewAnswer = 看汤底）
  page = await mini.currentPage()
  const revealTapped = await tapButton(page, '看汤底', { optional: true, waitMs: 800 })
  if (revealTapped) {
    check('揭晓确认弹窗', await dialogConfirm(page, 1_500))
    await shot('solo-revealed')
    // 换一题
    page = await mini.currentPage()
    const swap = await tapButton(page, '换一题', { optional: true, waitMs: 2_500 })
    check('换一题', swap)
    await shot('solo-swapped')
  } else {
    check('找到揭晓按钮', false)
  }
}

/** 会客厅：成员、选题、邀请菜单、公开开关、开始本局。返回是否开局成功 */
async function moduleLobby() {
  currentModule = 'lobby'
  await goHome()
  await waitSessionReady()
  let page = await mini.currentPage()
  await tapButton(page, '开房间', { waitMs: 500 })
  page = await waitPath(LOBBY_PATH, 12_000)
  check('进入会客厅', page && page.path.includes(LOBBY_PATH), `path=${page?.path}`)
  if (!page || !page.path.includes(LOBBY_PATH)) return false
  // 分包首开/IDE webview 竞态：等页面真的渲染出按钮再操作
  if (!(await waitForSelector(page, '.btn', 15_000, 1_000))) {
    check('会客厅渲染出操作区', false, '15 秒内没有出现任何按钮')
    return false
  }
  await shot('lobby')
  // 选题：进入题库选题模式选第一题（IDE webview 竞态会吃掉第一次 tap，失败重试一次）
  let selectTapped = await tapButton(page, '选题', { waitMs: 500 })
  let libPage = await waitPath('library', 8_000)
  if (!(libPage && libPage.path.includes('library')) && selectTapped) {
    page = await mini.currentPage()
    selectTapped = (await tapButton(page, '选题', { waitMs: 500 })) || selectTapped
    libPage = await waitPath('library', 8_000)
  }
  page = libPage
  check('选题入口进入题库', selectTapped && page && page.path.includes('library'), `path=${page?.path}`)
  if (selectTapped && page && page.path.includes('library')) {
    const picked = await tapButton(page, '选题', { waitMs: 500 })
    page = await waitPath(LOBBY_PATH, 10_000)
    check('选完题回到会客厅', picked && page && page.path.includes(LOBBY_PATH), `path=${page?.path}`)
  }
  await shot('lobby-selected')
  // 邀请菜单
  page = await mini.currentPage()
  const inviteTapped = await tapButton(page, '邀请', { waitMs: 1_500 })
  check('邀请按钮打开底部菜单', inviteTapped && (await hasClass(page, '.invite-sheet')))
  await shot('lobby-invite-sheet')
  if (await hasClass(page, '.invite-sheet')) {
    // 复制链接 → 剪贴板应含 /lobby/invite/
    await tapButton(page, '复制链接', { waitMs: 1_000 })
    try {
      const clip = await mini.callWxMethod('getClipboardData')
      const value = typeof clip === 'string' ? clip : clip?.data ?? clip?.result ?? ''
      check('复制邀请链接到剪贴板', String(value).includes('/lobby/invite/'), String(value).slice(0, 80))
    } catch (err) {
      check('复制邀请链接到剪贴板', false, `读剪贴板失败：${err.message}`)
    }
    // 重新打开菜单：先在菜单开着时验证转发按钮（关了就查不到），再取消关闭
    await tapButton(page, '邀请', { waitMs: 1_200 })
    // 微信转发按钮（openType=share）只验证存在：真点会拉起原生转发面板，阻塞自动化
    // （automator 不支持空格后代选择器，用菜单项自身的类名查）
    const shareBtn = await page.$('.invite-sheet-item')
    check('「邀请微信好友」转发按钮存在', !!shareBtn)
    await tapButton(page, '取消', { waitMs: 800 })
    check('取消关闭邀请菜单', !(await hasClass(page, '.invite-sheet')))
  }
  // 公开开关（VisibilityToggle 组件，不是 .btn，直接点开关本体）
  page = await mini.currentPage()
  const visEl = await page.$('.visibility-toggle')
  if (visEl) {
    await visEl.tap().catch(() => {})
    await sleep(1_200)
  }
  check('会客厅公开开关可点', !!visEl)
  // 开始本局（已选题）
  page = await mini.currentPage()
  const startTapped = await tapButton(page, '开始本局', { waitMs: 3_000 })
  page = await waitPath(ROOM_PATH, 15_000)
  const inRoom = page && page.path.includes(ROOM_PATH)
  check('开始本局进入房间', startTapped && inRoom, `path=${page?.path}`)
  return inRoom
}

/** 房间：提问、还原、提示、公布、再来一题、管理面板、邀请、解散 */
async function moduleRoom() {
  currentModule = 'room'
  let page = await mini.currentPage()
  // 单独跑本模块时没有前置 lobby：自举（建房 → 公开 → 选题 → 开局）
  if (!page?.path?.includes(ROOM_PATH)) {
    await goHome()
    await waitSessionReady()
    page = await mini.currentPage()
    await tapButton(page, '开房间', { waitMs: 500 })
    page = await waitPath(LOBBY_PATH, 12_000)
    if (!page || !page.path.includes(LOBBY_PATH)) {
      check('从会客厅进入房间', false, `lobby 没进去 path=${page?.path}`)
      return
    }
    const visEl = await page.$('.visibility-toggle')
    if (visEl) {
      await visEl.tap().catch(() => {})
      await sleep(1_200)
    }
    await tapButton(page, '选题', { waitMs: 500 })
    page = await waitPath('library', 8_000)
    if (page && page.path.includes('library')) {
      await tapButton(page, '选题', { waitMs: 500 })
      page = await waitPath(LOBBY_PATH, 10_000)
    }
    page = await mini.currentPage()
    await tapButton(page, '开始本局', { waitMs: 3_000 })
    page = await waitPath(ROOM_PATH, 15_000)
    if (!page || !page.path.includes(ROOM_PATH)) {
      check('从会客厅进入房间', false, `开局失败 path=${page?.path}`)
      return
    }
  }
  await shot('room')
  // 等房间同步就绪（快照 + WS 订阅完成后才渲染主体；卡「加载中」时这里会超时留证）
  const composer = await waitForSelector(page, '.composer-input', 45_000, 2_000)
  check('房间同步就绪（输入框渲染）', !!composer)
  // 提问（真实 Jev）
  const filled = await fillInput(page, '故事发生在室内吗？', 'textarea')
  check('房间输入提问', filled)
  const asked = await tapButton(page, '发送', { waitMs: 1_000 })
  check('房间点击发送提问', asked)
  const verdict = await waitForSelector(page, '.verdict-badge', 90_000, 2_000)
  check('房间 Jev 判定返回', !!verdict)
  await shot('room-asked')
  // 提示折叠开关
  page = await mini.currentPage()
  const hintToggle = await page.$('.hint-fold-toggle')
  if (hintToggle) {
    await hintToggle.tap()
    await sleep(800)
    check('提示胶囊展开/收起', true)
  }
  // 还原 tab（.mode-tab[0]=提问 [1]=还原）
  page = await mini.currentPage()
  const tabs = await page.$$('.mode-tab')
  if (tabs.length >= 2) {
    await tabs[1].tap()
    await sleep(900)
    page = await mini.currentPage()
    await fillInput(page, '主角是自己吓自己', 'textarea')
    const largeToggle = await page.$('.large-model-toggle')
    if (largeToggle) {
      await largeToggle.tap()
      await sleep(400)
      check('大模型开关可点', true)
    }
    await tapButton(page, '发送', { waitMs: 1_000 })
    const solveVerdict = await waitForSelector(page, '.verdict-badge', 90_000, 2_000)
    check('还原判定返回', !!solveVerdict)
    await shot('room-solved')
    // 回提问 tab
    const tabsBack = await page.$$('.mode-tab')
    await tabsBack[0].tap()
    await sleep(800)
  } else {
    check('还原 tab 存在', false, '没找到 .mode-tab')
  }
  // 成员管理面板（悬浮卡片）：进行中房间的「邀请 / 解散」都在面板里；入口是顶栏「成员 n/cap」
  page = await mini.currentPage()
  const mgmtTapped = await tapButton(page, '成员', { optional: true, waitMs: 900 })
  if (mgmtTapped) {
    page = await mini.currentPage()
    check('管理面板打开', await hasClass(page, '.room-management') || (await page.$$('.btn-danger')).length > 0)
    await shot('room-management')
    // 邀请（面板内按钮 → 底部菜单 → 复制 /room/invite/；复制后菜单自动关闭）
    page = await mini.currentPage()
    if (await tapButton(page, '邀请', { waitMs: 1_500 })) {
      if (await hasClass(page, '.invite-sheet')) {
        await tapButton(page, '复制链接', { waitMs: 1_000 })
        try {
          const clip = await mini.callWxMethod('getClipboardData')
          const value = typeof clip === 'string' ? clip : clip?.data ?? clip?.result ?? ''
          check('房间复制邀请链接', String(value).includes('/room/invite/'), String(value).slice(0, 80))
        } catch (err) {
          check('房间复制邀请链接', false, `读剪贴板失败：${err.message}`)
        }
      }
    }
    // 收起面板
    page = await mini.currentPage()
    const mask = await page.$('.room-management-mask')
    if (mask) {
      await mask.tap()
      await sleep(600)
    }
  } else {
    check('找到成员管理入口', false, '页面上现有：' + (await buttonTexts(await mini.currentPage())).texts.filter(Boolean).join(' / '))
  }
  // 公开开关（房间内 set_visibility）
  page = await mini.currentPage()
  await tapButton(page, '公开', { optional: true, waitMs: 1_500 })
  // 公布答案
  page = await mini.currentPage()
  const revealTapped = await tapButton(page, '公布', { optional: true, waitMs: 900 })
  if (revealTapped) {
    check('公布答案确认弹窗', await dialogConfirm(page, 2_000))
    await shot('room-revealed')
  } else {
    check('找到公布答案按钮', false)
  }
  // 再来一题（结算页 → 题库选题 → 新房）；题库列表渲染慢，等选题卡片出现再点
  page = await mini.currentPage()
  const followup = await tapButton(page, '再来一题', { optional: true, waitMs: 500 })
  page = await waitPath('library', 8_000)
  if (followup && page && page.path.includes('library')) {
    const selectCard = await waitForSelector(page, '.puzzle-select-btn', 20_000, 1_000)
      ?? (await (async () => {
        // 类名兜底：等任一含「选题」文案的按钮
        for (let i = 0; i < 20; i++) {
          const { texts } = await buttonTexts(page)
          if (texts.some((t) => t.includes('选题'))) return true
          await sleep(1_000)
        }
        return null
      })())
    const picked = selectCard ? await tapButton(page, '选题', { waitMs: 500 }) : false
    page = await waitPath(ROOM_PATH, 15_000)
    check('再来一题建新房并进入', picked && page && page.path.includes(ROOM_PATH), `path=${page?.path}`)
    await shot('room-followup')
  } else {
    check('再来一题入口', false, `followup=${followup} path=${page?.path}`)
  }
  // 解散新房（残留清理 + 测解散）：解散入口在成员管理面板里
  page = await mini.currentPage()
  if (await tapButton(page, '成员', { optional: true, waitMs: 900 })) {
    page = await mini.currentPage()
    const dissolve = await tapButton(page, '解散', { optional: true, waitMs: 900 })
    if (dissolve) {
      check('解散确认弹窗', await dialogConfirm(page, 2_500))
      page = await waitPath('index/index', 8_000)
      check('解散后回首页', page && page.path.includes('index/index'), `path=${page?.path}`)
      await shot('room-dissolved')
    } else {
      check('找到解散按钮', false, '面板里没有解散按钮：' + (await buttonTexts(page)).texts.filter(Boolean).join(' / '))
    }
  } else {
    check('找到解散按钮', false, '新房页没找到成员管理入口：' + (await buttonTexts(page)).texts.filter(Boolean).join(' / '))
  }
}

/** 大厅：公开房间可见、行点击进房；顺带清理（解散测试房） */
async function moduleHall() {
  currentModule = 'hall'
  // 造一间公开房：建房 → 开公开 → 开局
  await goHome()
  await waitSessionReady()
  let page = await mini.currentPage()
  await tapButton(page, '开房间', { waitMs: 500 })
  page = await waitPath('lobby', 12_000)
  if (!page || !page.path.includes('lobby')) {
    check('建房进入会客厅', false, `path=${page?.path}`)
    return
  }
  check('建房进入会客厅', true, `path=${page.path}`)
  // 公开开关（VisibilityToggle 组件）：开公开让本房进大厅
  const hallVis = await page.$('.visibility-toggle')
  if (hallVis) {
    await hallVis.tap().catch(() => {})
    await sleep(1_200)
  }
  await tapButton(page, '选题', { waitMs: 500 })
  page = await waitPath('library', 8_000)
  if (page && page.path.includes('library')) {
    await tapButton(page, '选题', { waitMs: 500 })
    page = await waitPath(LOBBY_PATH, 10_000)
  }
  // 开始本局：选题回跳后快照可能还没刷出 selectedPuzzle（按钮短暂 disabled，点了没反应），
  // 点完仍在 lobby 就等快照刷新后重试
  page = await mini.currentPage()
  let started = false
  for (let attempt = 0; attempt < 5 && !started; attempt++) {
    await tapButton(page, '开始本局', { optional: true, waitMs: 500 })
    page = await waitPath(ROOM_PATH, 4_000)
    started = !!page && page.path.includes(ROOM_PATH)
    if (!started) {
      page = await mini.currentPage()
      await sleep(1_500)
    }
  }
  if (!started) {
    check('开局进入房间', false, `path=${page?.path}`)
    return
  }
  check('开局进入房间', true, `path=${page.path}`)
  // 回首页进大厅
  await goHome()
  page = await mini.currentPage()
  await tapButton(page, '大厅', { waitMs: 500 })
  page = await waitPath('hall', 8_000)
  check('进入大厅', page && page.path.includes('hall'), `path=${page?.path}`)
  await shot('hall')
  const rows = await page.$$('.hall-row')
  check('大厅列出公开房间', rows.length > 0, `${rows.length} 行`)
  // 点行进房（行内「加入」按钮；首行可能是自己刚开的房或满员房，失败换下一行，最多试 3 行）
  if (rows.length > 0) {
    let entered = false
    for (let i = 0; i < Math.min(3, rows.length) && !entered; i++) {
      const joinBtns = await page.$$('.hall-row .btn').catch(() => [])
      const btn = joinBtns[i]
      if (!btn) break
      try {
        await btn.tap()
      } catch {
        break
      }
      await sleep(1_500)
      const cur = await mini.currentPage().catch(() => null)
      if (cur && String(cur.path ?? '').includes(ROOM_PATH)) entered = true
    }
    // 失败时顺带取证：加入被服务端拒绝的原因会显示在 error-text（如「已在房间中」）
    let detail = `path=${(await mini.currentPage().catch(() => null))?.path ?? '?'}`
    try {
      const cur = await mini.currentPage()
      const errEl = cur ? await cur.$('.error-text') : null
      if (errEl) detail += ` err=${(await errEl.text()).slice(0, 80)}`
    } catch {}
    check('大厅行点击进入房间', entered, detail)
  }
  // 清理：解散这间房
  page = await mini.currentPage()
  if (page && page.path.includes(ROOM_PATH)) {
    if (await tapButton(page, '解散', { optional: true, waitMs: 900 })) {
      await dialogConfirm(page, 2_500)
      await waitPath('index/index', 8_000)
    }
  }
}

/** 好友：搜索错误分支（自加/不存在）；真实申请链路需第二账号，标注 */
async function moduleFriends() {
  currentModule = 'friends'
  await goHome()
  await waitSessionReady()
  let page = await mini.currentPage()
  await tapButton(page, '好友', { waitMs: 500 })
  page = await waitPath('friends', 8_000)
  check('进入好友页', page && page.path.includes('friends'), `path=${page?.path}`)
  await shot('friends')
  // 搜一个不存在的邮箱
  await fillInput(page, 'nobody-e2e@jev-e2e.test')
  const searched = await tapButton(page, '搜索', { optional: true, waitMs: 2_000 })
  if (!searched) {
    // 可能是键盘确认触发：直接读页面上是否有错误
    check('点击搜索', false, '没找到搜索按钮（确认键触发的设计）')
  }
  page = await mini.currentPage()
  // 精确搜索不存在邮箱：产品行为是空结果提示（HTTP 200 不报错），文案「没有找到这个邮箱对应的用户」
  const noResult = (await page.$('.error-text')) !== null || (await textExists(page, '没有找到'))
  check('搜不存在邮箱给出无结果提示', !!noResult)
  await shot('friends-search-miss')
}

/** 私聊页：无真实会话时的错误态渲染 */
async function moduleChat() {
  currentModule = 'chat'
  await mini.reLaunch('/pkg-social/pages/chat/chat?id=e2e-nonexistent')
  await waitPath('chat', 8_000)
  const page = await mini.currentPage()
  check('私聊页打开（伪造会话 id）', page && page.path.includes('chat'), `path=${page?.path}`)
  await shot('chat-error')
  await goBack('index/index')
}

/** 通知中心：空态、全部已读 */
async function moduleNotifications() {
  currentModule = 'notifications'
  await mini.reLaunch('/pkg-social/pages/notifications/notifications')
  await waitPath('notifications', 8_000)
  const page = await mini.currentPage()
  check('通知页打开', page && page.path.includes('notifications'), `path=${page?.path}`)
  await shot('notifications')
  await tapButton(page, '全部已读', { optional: true, waitMs: 1_500 })
  check('全部已读可点', true)
}

/** 创作：新建→保存→编辑→私测→提交→撤回（回到草稿态收尾；小程序与 web 都没有删除入口） */
async function moduleCreations() {
  currentModule = 'creations'
  await goHome()
  await waitSessionReady()
  let page = await mini.currentPage()
  await tapButton(page, '我的作品', { waitMs: 500 })
  page = await waitPath('list', 8_000)
  check('进入创作列表', page && page.path.includes('list'), `path=${page?.path}`)
  if (!page || !page.path.includes('list')) return
  await shot('creations')
  // 新建（topbar-tail 按钮「写一碗汤」）
  const created = await tapButton(page, '写一碗汤', { optional: true, waitMs: 500 })
  if (!created) {
    // 空态时的主按钮
    await tapButton(page, '写', { optional: true, waitMs: 500 })
  }
  page = await waitPath('editor', 8_000)
  check('新建进入编辑器', page && page.path.includes('editor'), `path=${page?.path}`)
  if (!page || !page.path.includes('editor')) return
  await shot('editor-new')
  // 填表：标题/汤面/汤底/提示（字段顺序以页面为准，逐个 input/textarea 填）
  await fillInput(page, 'E2E 自动化测试题', 'input', 0)
  const areas = await page.$$('textarea')
  const answers = ['一个人在暴雨夜死亡', '他打伞时被雷劈中', '雷雨天不要站在空旷处打伞']
  for (let i = 0; i < Math.min(areas.length, answers.length); i++) {
    await areas[i].input(answers[i])
    await sleep(200)
  }
  // 类别/难度 chips（存在则点「本格」与「适中」）
  await tapButton(page, '本格', { optional: true, waitMs: 400 })
  await tapButton(page, '适中', { optional: true, waitMs: 400 })
  // 保存草稿
  const saved = await tapButton(page, '保存', { waitMs: 500 })
  check('保存草稿', saved)
  page = await waitPath('editor', 8_000)
  check('保存后进入带 id 编辑页', page && page.path.includes('editor'), `path=${page?.path}`)
  await shot('editor-saved')
  // 私人试题预览（真实 Jev）
  page = await mini.currentPage()
  const editorUrl = pageUrl(await mini.currentPage())
  const previewTapped = await tapButton(page, '私人试题', { optional: true, waitMs: 500 })
  page = await waitPath('preview', 8_000)
  if (page && page.path.includes('preview')) {
    check('进入私测预览页', true)
    await shot('preview')
    await fillInput(page, '他是被雷劈死的吗？', 'textarea')
    await tapButton(page, '发送', { optional: true, waitMs: 1_000 })
    if (!(await page.$('.verdict-badge'))) {
      await tapButton(page, '问 Jev', { optional: true, waitMs: 1_000 })
    }
    const verdict = await waitForSelector(page, '.verdict-badge', 90_000, 2_000)
    check('私测判定返回', !!verdict)
    await shot('preview-asked')
    page = await goBack('editor', editorUrl ?? '/pkg-creation/pages/list/list')
  } else {
    check('进入私测预览页', false, `path=${page?.path}`)
  }
  // 提交审核
  page = await mini.currentPage()
  const submitted = await tapButton(page, '提交', { optional: true, waitMs: 1_000 })
  if (submitted) {
    check('提交确认弹窗', await dialogConfirm(page, 3_000))
    await shot('editor-submitted')
    // 撤回并编辑（回到草稿态收尾）。提交后页面替换为带 id 的编辑页，detail 走生产
    // API 有延迟，撤回按钮（submitted/checking/pending_review 态）要轮询着等；
    // 等不到就是投稿留在了生产审核队列（AI 初审可能已自动发布），必须人工下架
    let withdrawBtn = null
    page = await mini.currentPage()
    for (let i = 0; i < 15; i++) {
      const btns = await page.$$('.btn')
      for (const b of btns) {
        if (((await b.text()) ?? '').includes('撤回')) { withdrawBtn = b; break }
      }
      if (withdrawBtn) break
      await sleep(1_200)
      page = await mini.currentPage()
    }
    if (withdrawBtn) {
      await withdrawBtn.tap()
      check('撤回确认弹窗', await dialogConfirm(page, 2_500))
      await shot('editor-withdrawn')
    } else {
      check('找到撤回按钮', false, '投稿滞留生产审核队列（可能已被 AI 初审自动发布），需在后台下架')
    }
  }
  await shot('creations-after')
}

/** 我的 + 设置：入口、历史行、邀请复制、广告占位、昵称改还原、语言切换、兑换码错误、隐私、退出 */
async function moduleMe() {
  currentModule = 'me'
  await goHome()
  await waitSessionReady()
  let page = await mini.currentPage()
  await tapButton(page, '我的', { optional: true, waitMs: 500 })
  page = await waitPath('/me', 8_000)
  if (!page || !page.path.includes('/me')) {
    check('进入我的页', false, `path=${page?.path}`)
    return
  }
  await shot('me')
  // 历史行点击进房间（我们的测试房已归档，应有多条）
  const historyRow = await page.$('.me-history-item')
  if (historyRow) {
    await historyRow.tap()
    page = await waitPath(ROOM_PATH, 10_000)
    check('历史行点击进房间', page && page.path.includes(ROOM_PATH), `path=${page?.path}`)
    page = await goBack('/me', '/pages/me/me')
  } else {
    check('历史列表有行', false, '（应至少有本次测试的归档房）')
  }
  // 邀请卡复制
  const inviteCopy = await page.$('.invite-link')
  if (inviteCopy) {
    await inviteCopy.tap()
    await sleep(1_000)
    try {
      const clip = await mini.callWxMethod('getClipboardData')
      const value = typeof clip === 'string' ? clip : clip?.data ?? clip?.result ?? ''
      check('邀请码链接复制', /ref=|invite/.test(String(value)), String(value).slice(0, 80))
    } catch (err) {
      check('邀请码链接复制', false, `读剪贴板失败：${err.message}`)
    }
  }
  // 广告按钮（流量主未开 → 「开通中」提示）
  await tapButton(page, '广告', { optional: true, waitMs: 1_500 })
  check('广告入口可点', true)
  // 设置页
  await tapButton(page, '设置', { waitMs: 500 })
  page = await waitPath('settings', 8_000)
  check('进入设置页', page && page.path.includes('settings'), `path=${page?.path}`)
  await shot('settings')
  // 昵称：记录原值 → 改 → 还原（保存按钮文案是「修改」）
  const inputs = await page.$$('input')
  let originalNickname = ''
  if (inputs.length > 0) {
    try {
      originalNickname = (await inputs[0].attribute('value')) || ''
    } catch {}
  }
  if (inputs.length > 0) {
    await inputs[0].input('E2E测试昵称')
    await sleep(300)
    if (await tapButton(page, '修改', { optional: true, waitMs: 2_000 })) {
      check('昵称保存', true)
      await inputs[0].input(originalNickname || '玩家')
      await sleep(300)
      await tapButton(page, '修改', { optional: true, waitMs: 2_000 })
      check('昵称还原', true, `原值=「${originalNickname}」`)
    }
  }
  // 兑换码：假码 → 错误提示（兑换码输入框按 placeholder 定位，避开昵称框）
  const inputs2 = await page.$$('input')
  let redeemEl = null
  for (const el of inputs2) {
    try {
      const ph = (await el.attribute('placeholder')) || ''
      if (ph.includes('码')) {
        redeemEl = el
        break
      }
    } catch {}
  }
  if (redeemEl) {
    await redeemEl.input('E2E-FAKE-CODE')
    await sleep(300)
  }
  await tapButton(page, '兑换', { optional: true, waitMs: 2_000 })
  page = await mini.currentPage()
  check('无效兑换码报错', await hasClass(page, '.error-text'))
  await shot('settings-redeem-fail')
  // 隐私政策（settings 里是 .btn 按钮，裸文本不在 text 标签里，tapText 查不到）
  await tapButton(page, '隐私政策', { optional: true, waitMs: 500 })
  page = await waitPath('privacy', 8_000)
  check('隐私政策页打开', page && page.path.includes('privacy'), `path=${page?.path}`)
  page = await goBack('settings', '/pages/settings/settings')
  // 语言切换（English ↔ 中文）放在最后：切英文后中文文案按钮都会失配
  const langTapped = await tapButton(page, 'English', { optional: true, waitMs: 1_500 })
  if (langTapped) {
    check('切到英文界面', true)
    await shot('settings-en')
    // 英文界面下中文按钮的文案是「Chinese」（copy.languageChinese 的 en 值），先试中文再试英文拼写
    const backTapped = (await tapButton(page, '中文', { optional: true, waitMs: 800 }))
      || (await tapButton(page, 'Chinese', { optional: true, waitMs: 1_500 }))
    check('切回中文界面', backTapped)
    page = await mini.currentPage()
  }
  // 退出登录（弹窗确认）→ 回登录页
  const logout = await tapButton(page, '退出登录', { optional: true, waitMs: 900 })
  if (logout) {
    check('退出登录弹窗', await dialogConfirm(page, 2_500))
    await sleep(1_500)
    page = await mini.currentPage()
    check('退出后回登录页', page.path.includes('login') || page.path.includes('index'), `path=${page.path}`)
    await shot('logged-out')
  } else {
    check('找到退出登录按钮', false)
  }
}

// ---------- 主流程 ----------

/** automator 桥卡死时的恢复：杀掉开发者工具进程树并重新拉起（模态卡死只有重启能解） */
async function restartDevtools() {
  try {
    await mini.disconnect()
  } catch {}
  mini = null
  try {
    execSync('taskkill /F /IM "微信开发者工具.exe" /T', { stdio: 'ignore' })
  } catch {}
  await sleep(3_000)
  launchDevTools()
  for (let waited = 0; waited < 150_000 && !mini; waited += 3_000) {
    try {
      const connection = await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)
      mini = new MiniProgram(connection)
    } catch {
      await sleep(3_000)
    }
  }
  if (!mini) throw new Error('重启后 150 秒内没能连上开发者工具')
  for (let waited = 0; waited < 90_000; waited += 3_000) {
    try {
      await withTimeout(mini.systemInfo(), 8_000, 'systemInfo')
      break
    } catch {
      await sleep(3_000)
    }
  }
  await goHome()
  await waitSessionReady()
}

const modules = {
  login: moduleLogin,
  home: moduleHome,
  library: moduleLibrary,
  solo: moduleSolo,
  lobby: moduleLobby,
  room: moduleRoom,
  hall: moduleHall,
  friends: moduleFriends,
  chat: moduleChat,
  notifications: moduleNotifications,
  creations: moduleCreations,
  me: moduleMe,
}
const runList = onlyModules.length > 0 ? onlyModules.filter((m) => modules[m]) : Object.keys(modules)
if (onlyModules.some((m) => !modules[m])) {
  console.error(`未知模块：${onlyModules.filter((m) => !modules[m]).join(' / ')}`)
  process.exit(2)
}

try {
  for (const name of runList) {
    console.log(`\n===== 模块 ${name} =====`)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await modules[name]()
        break
      } catch (err) {
        const msg = err.message || ''
        // 模块级报错都是环境/桥问题（业务失败走 check 不抛错）：重启开发者工具后重试，最多两次
        if (attempt < 2) {
          console.log(`模块 ${name} 执行中断（${msg.split('\n')[0]}），重启开发者工具后重试…`)
          try {
            await restartDevtools()
            continue
          } catch (e) {
            check('重启开发者工具', false, e.message)
          }
        }
        check(`模块 ${name} 执行`, false, err.stack?.split('\n').slice(0, 3).join(' | ') || msg)
        await shot(`error-${name}`)
        break
      }
    }
  }
} finally {
  // 覆盖表 + 结果汇总
  console.log('\n===== 按钮覆盖表 =====')
  for (const [pagePath, rows] of coverage) {
    const missed = rows.filter((r) => !r.tapped).map((r) => r.text)
    console.log(`${pagePath}: 已点 ${rows.filter((r) => r.tapped).length}，未点 ${missed.length}${missed.length ? `（${missed.join(' / ')}）` : ''}`)
  }
  const pass = results.filter((r) => r.pass).length
  const fail = results.filter((r) => !r.pass)
  console.log(`\n===== 结果：${pass} 通过 / ${fail.length} 失败 =====`)
  for (const r of fail) console.log(`✗ [${r.module}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  await mini.disconnect()
  process.exit(fail.length > 0 ? 1 : 0)
}
