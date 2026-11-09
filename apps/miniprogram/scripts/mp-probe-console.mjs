// 探针：抓小程序启动期 console 与异常，定位整页空白的运行时错误
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { default: connectionCtor } = await import(import.meta.resolve('miniprogram-automator/out/Connection.js'))
const { default: miniProgramCtor } = await import(import.meta.resolve('miniprogram-automator/out/MiniProgram.js'))
const Connection = connectionCtor.default ?? connectionCtor
const MiniProgram = miniProgramCtor.default ?? miniProgramCtor

const INSTALL_DIR = 'D:/Program Files (x86)/微信web开发者工具'
const PROJECT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

let mini = null
try {
  mini = new MiniProgram(await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`))
  console.log('已连上现有会话')
} catch {
  launchDevTools()
  for (let i = 0; i < 50 && !mini; i++) {
    try { mini = new MiniProgram(await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)) } catch { await new Promise((r) => setTimeout(r, 3_000)) }
  }
}
if (!mini) throw new Error('连不上')

const fmt = (args) => (args ?? []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
mini.on('console', (msg) => console.log(`[console:${msg.type}] ${fmt(msg.args)?.slice(0, 400)}`))
mini.on('exception', (err) => console.log(`[exception] ${err.message}\n${err.stack ?? ''}`))

for (let i = 0; i < 20; i++) { try { await mini.systemInfo(); break } catch { await new Promise((r) => setTimeout(r, 3_000)) } }
console.log('--- reLaunch 首页 ---')
try {
  await mini.reLaunch('/pages/index/index')
  const page = await mini.currentPage()
  console.log('path =', page?.path)
  console.log('view 数 =', (await page.$$('view')).length)
} catch (err) {
  console.log('reLaunch/currentPage 失败:', err.message)
}
await new Promise((r) => setTimeout(r, 6_000))
console.log('--- 探针结束 ---')
process.exit(0)
