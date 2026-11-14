/**
 * 定向补截图：对 mp-screenshot.mjs 没覆盖的带参数路由逐页截图。
 * 用法：node scripts/mp-shot-pages.mjs <输出目录> <名称=路由 ...>
 * 例：node scripts/mp-shot-pages.mjs out "library-select=/pages/library/library?mode=select"
 * 环境变量 MP_PROJECT_PATH 可指到隔离壳项目（IDE 缓存劣化时用）。
 */
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { default: connectionCtor } = await import(import.meta.resolve('miniprogram-automator/out/Connection.js'))
const { default: miniProgramCtor } = await import(import.meta.resolve('miniprogram-automator/out/MiniProgram.js'))
const Connection = connectionCtor.default ?? connectionCtor
const MiniProgram = miniProgramCtor.default ?? miniProgramCtor

const INSTALL_DIR = 'D:/Program Files (x86)/微信web开发者工具'
const PROJECT_PATH = process.env.MP_PROJECT_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTO_PORT = 9420

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
const targets = process.argv.slice(3).map((arg) => {
  const eq = arg.indexOf('=')
  return { name: arg.slice(0, eq), url: arg.slice(eq + 1) }
})
if (!outputDir || targets.length === 0) {
  console.error('用法：node scripts/mp-shot-pages.mjs <输出目录> <名称=路由 ...>')
  process.exit(1)
}
await mkdir(outputDir, { recursive: true })

let mini = null
try {
  mini = new MiniProgram(await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`))
  console.log('已连上现有自动化会话')
} catch {
  launchDevTools()
  for (let waited = 0; waited < 120_000 && !mini; waited += 2_000) {
    try { mini = new MiniProgram(await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)) } catch { await new Promise((r) => setTimeout(r, 2_000)) }
  }
}
if (!mini) throw new Error('连不上开发者工具自动化端口')

// 编译窗口内命令无人应答：先轮询到运行时就绪
let ready = false
for (let waited = 0; waited < 90_000; waited += 3_000) {
  try { await mini.systemInfo(); ready = true; break } catch { await new Promise((r) => setTimeout(r, 3_000)) }
}
if (!ready) throw new Error('90 秒内模拟器未就绪')

for (const { name, url } of targets) {
  const page = await mini.reLaunch(url)
  await page.waitFor(1500)
  await mini.screenshot({ path: path.join(outputDir, `${name}.png`) })
  console.log(`已截图 ${name}`)
}
process.exit(0)
