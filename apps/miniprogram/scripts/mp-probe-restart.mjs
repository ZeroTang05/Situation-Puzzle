// 探针：优雅重启开发者工具（cli quit → cli auto），长窗口等待编译就绪后验证渲染
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
const EXE = `${INSTALL_DIR}/微信开发者工具.exe`
const CLI = `${INSTALL_DIR}/resources/app.asar.unpacked/js/common/cli/index.js`

/** 通过 electron run-as node 调 CLI（与 mp-screenshot 同款套路） */
function runCli(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const bootstrap = `const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});process.env.cwd=process.cwd();process.argv=[process.execPath,'--ms-enable-electron-run-as-node',e,'--electron'].concat(a);require(e)`
    const child = spawn(EXE, ['-e', bootstrap, CLI, ...args], {
      cwd: INSTALL_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.stdin.write('y\n')
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

function launchAuto() {
  const bootstrap = `const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});process.env.cwd=process.cwd();process.argv=[process.execPath,'--ms-enable-electron-run-as-node',e,'--electron'].concat(a);require(e)`
  const child = spawn(EXE, ['-e', bootstrap, CLI, 'auto', '--project', PROJECT_PATH, '--auto-port', String(AUTO_PORT), '--trust-project'], {
    cwd: INSTALL_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.write('y\n')
  return child
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('优雅退出开发者工具…')
console.log((await runCli(['quit'])).slice(0, 200))
await sleep(3_000)

console.log('重新拉起 auto…')
launchAuto()

let mini = null
for (let i = 0; i < 60 && !mini; i++) {
  try { mini = new MiniProgram(await Connection.create(`ws://127.0.0.1:${AUTO_PORT}`)) } catch { await sleep(3_000) }
}
if (!mini) throw new Error('180 秒没连上自动化端口')
console.log('已连上，等待编译就绪…')

let ready = false
for (let i = 0; i < 60 && !ready; i++) {
  try { await mini.systemInfo(); ready = true } catch { await sleep(3_000) }
}
if (!ready) throw new Error('systemInfo 一直超时')

// 编译就绪后还要等页面真的渲染出 DOM
let ok = false
for (let i = 0; i < 60 && !ok; i++) {
  try {
    await mini.reLaunch('/pages/index/index')
    const page = await mini.currentPage()
    const views = (await page.$$('view')).length
    console.log(`[${i}] path=${page?.path} view=${views}`)
    if (views > 0) { ok = true; break }
  } catch (err) { console.log(`[${i}] ${err.message.split('\n')[0]}`) }
  await sleep(3_000)
}
console.log(ok ? '渲染正常 ✓' : '3 分钟内页面始终空白 ✗')
process.exit(ok ? 0 : 1)
