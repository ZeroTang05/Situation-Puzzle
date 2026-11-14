/**
 * 小程序 UI 截图审计：用 miniprogram-automator 拉起微信开发者工具模拟器，
 * 逐页打开并截图到指定目录，供与 web 端 UI 对照验收。
 *
 * 用法：node scripts/mp-screenshot.mjs <输出目录> [--tap "选择器@文件名"]
 * 前置：微信开发者工具已安装且「设置-安全设置-服务端口」开启。
 */
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 绕过 launcher.connect 里的 checkVersion（它对当前 DevTools 版本串解析崩溃），
// 直接用 Connection + MiniProgram 建会话（等价于 launcher.connectTool）；
// CJS 经 ESM import 进来是双重 default 包装
const { default: connectionCtor } = await import(import.meta.resolve('miniprogram-automator/out/Connection.js'))
const { default: miniProgramCtor } = await import(import.meta.resolve('miniprogram-automator/out/MiniProgram.js'))
const Connection = connectionCtor.default ?? connectionCtor
const MiniProgram = miniProgramCtor.default ?? miniProgramCtor

const INSTALL_DIR = 'D:/Program Files (x86)/微信web开发者工具'
// scripts/ 的上一级 = 项目根（注意：new URL('..') 已带尾分隔符，不能直接再 dirname）；
// IDE 项目级缓存劣化时可用 MP_PROJECT_PATH 指到隔离壳（.ideshell，内含 dist 实体拷贝）
const PROJECT_PATH = process.env.MP_PROJECT_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTO_PORT = 9420

/** 拉起开发者工具自动化端口：复刻 cli.bat（Electron exe 以 node 模式跑 CLI 脚本，
 *  参数走数组没有 cmd 编码问题）；stdin 写入 y 确认首次开启服务端口 */
function launchDevTools() {
  const exe = `${INSTALL_DIR}/微信开发者工具.exe`
  const cli = `${INSTALL_DIR}/resources/app.asar.unpacked/js/common/cli/index.js`
  const bootstrap = `const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});process.env.cwd=process.cwd();process.argv=[process.execPath,'--ms-enable-electron-run-as-node',e,'--electron'].concat(a);require(e)`
  const child = spawn(exe, ['-e', bootstrap, cli, 'auto', '--project', PROJECT_PATH, '--auto-port', String(AUTO_PORT), '--trust-project'], {
    // CLI 内部以相对路径 ./微信开发者工具.exe 拉起 IDE，cwd 必须是安装目录
    cwd: INSTALL_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  // CLI 首次调用询问「是否开启服务端口」，回 y 确认
  child.stdin.write('y\n')
  return child
}

const outputDir = process.argv[2]
if (!outputDir) {
  console.error('用法：node scripts/mp-screenshot.mjs <输出目录>')
  process.exit(1)
}
await mkdir(outputDir, { recursive: true })

/** API_BASE 与 src/api/client.ts 保持一致 */
const API_BASE = 'https://sp.xiaobaozi.cn'

/** 从生产题库取一个真实题目 id，供单人页截图；生产不可达时跳过该页 */
async function firstPuzzleId() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/puzzles?language=zh&sort=popular&limit=1`)
    const body = await res.json()
    // 统一信封：业务数据在 body.data 里
    return body.data?.items?.[0]?.id ?? ''
  } catch {
    console.warn('API 不可达，单人页截图跳过')
    return ''
  }
}

// 先试直连（已有自动化会话时不要重开，重开会踢掉旧连接），连不上才拉 CLI
let mini = null
try {
  const connection = await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)
  mini = new MiniProgram(connection)
  console.log('已连上现有自动化会话')
} catch {
  console.log('没有现成会话，拉起开发者工具自动化…')
  const devtools = launchDevTools()
  for (let waited = 0; waited < 120_000; waited += 2_000) {
    try {
      const connection = await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)
      mini = new MiniProgram(connection)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  if (!mini) {
    devtools.kill()
    throw new Error('120 秒内没能连上开发者工具自动化端口')
  }
}
if (!mini) {
  devtools.kill()
  throw new Error('120 秒内没能连上开发者工具自动化端口：请确认工具已登录且「设置-安全设置-服务端口」已开启')
}

// 刚重建 dist 会触发模拟器重编译，编译窗口内命令无人应答；先轮询到运行时就绪
{
  let ready = false
  for (let waited = 0; waited < 90_000; waited += 3_000) {
    try {
      await mini.systemInfo()
      ready = true
      break
    } catch {
      console.log('等待模拟器就绪…')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
  }
  if (!ready) throw new Error('90 秒内模拟器未就绪（可能仍在编译或项目打开失败）')
}

const pages = [
  ['home', '/pages/index/index'],
  ['library', '/pages/library/library'],
  ['login', '/pages/login/login'],
  ['me', '/pages/me/me'],
  ['settings', '/pages/settings/settings'],
  ['privacy', '/pages/privacy/privacy'],
  // 多人分包：room/lobby 需要真实 id，未登录时验证登录引导态布局
  ['hall', '/pkg-room/pages/hall/hall'],
  ['lobby', '/pkg-room/pages/lobby/lobby?id=x'],
  ['room', '/pkg-room/pages/room/room?id=x'],
  ['invite-room', '/pkg-room/pages/invite/invite?kind=room&token=deadbeef'],
  // 社交分包：chat 需要会话 id，未登录验证引导态
  ['friends', '/pkg-social/pages/friends/friends'],
  ['chat', '/pkg-social/pages/chat/chat?id=x'],
  ['notifications', '/pkg-social/pages/notifications/notifications'],
  // 创作分包：editor 无 id = 新建
  ['creations', '/pkg-creation/pages/list/list'],
  ['creation-editor', '/pkg-creation/pages/editor/editor'],
]

const puzzleId = await firstPuzzleId()
if (puzzleId) pages.splice(2, 0, ['solo', `/pages/solo/solo?puzzleId=${puzzleId}`])

for (const [name, url] of pages) {
  const page = await mini.reLaunch(url)
  await page.waitFor(1500)
  await mini.screenshot({ path: path.join(outputDir, `${name}.png`) })
  console.log(`已截图 ${name}`)
}

// 交互态：首页「?」玩法弹窗
{
  const page = await mini.reLaunch('/pages/index/index')
  await page.waitFor(1200)
  const help = await page.$('.help-btn')
  if (help) {
    await help.tap()
    await page.waitFor(600)
    await mini.screenshot({ path: path.join(outputDir, 'home-intro-dialog.png') })
    console.log('已截图 home-intro-dialog')
  }
}

await mini.close()
