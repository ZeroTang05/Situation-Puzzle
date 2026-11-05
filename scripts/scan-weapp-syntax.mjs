/**
 * 微信小程序兼容扫描：build:weapp / build:mp 之后跑（node scripts/scan-weapp-syntax.mjs）。
 * 两类检查（踩坑沉淀，详见 docs/rebuild/20-MINIPROGRAM.md M2.7）：
 * 1. 语法：预览器对部分 ES2021/ES2022 语法报 Invalid/Unexpected token（实测踩过
 *    私有字段 #x 与逻辑赋值 ||=），AST 找逻辑赋值、class 公有/私有字段、私有方法、静态块；
 * 2. 未声明全局：小程序运行时没有浏览器的 Fetch/DOM 全局（踩过 Request、fetch），
 *    作用域分析找所有「未声明的全局引用」，再对照白名单（JS 内建 + 微信宿主注入），
 *    白名单外的都是运行时 ReferenceError 风险——需要 polyfill 或从依赖里剔除。
 * 输出 文件:行:列 + 说明 + 片段；两类均 0 处即通过。
 */
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const appDir = join(repoRoot, 'apps', 'miniprogram')
const req = createRequire(resolve(appDir, 'noop.js'))

// @babel/parser 与 @babel/traverse 都是 @babel/core 的传递依赖，从其真实目录解析
const coreEntry = req.resolve('@babel/core')
const coreReq = createRequire(coreEntry)
const parser = coreReq('@babel/parser')
const traverseMod = coreReq('@babel/traverse')
const traverse = traverseMod.default ?? traverseMod

// ---------- 检查一：微信预览器不认的语法节点 ----------
const BAD_TYPES = new Set([
  'ClassProperty',            // class 公有字段 x = 1
  'ClassPrivateProperty',     // 私有字段 #x
  'ClassPrivateMethod',       // 私有方法 #m(){}
  'PrivateName',              // 任何 #名字 引用
  'StaticBlock',              // static {}
])
const BAD_ASSIGN = new Set(['||=', '&&=', '??='])

// ---------- 检查二：未声明全局引用的白名单 ----------
// JS 语言内建 + 微信小程序宿主 / webpack 模块系统真实注入的名字；
// 浏览器专属（fetch/Request/Response/window/document/localStorage…）故意不列，
// 引用了就是运行时 ReferenceError 风险，会被报出来（typeof 守卫式的引用安全，
// 扫描时自动跳过）。
const DECLARED_GLOBALS = new Set([
  // 语言内建
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Function', 'Symbol', 'BigInt',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'ReferenceError',
  'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'Promise', 'Proxy', 'Reflect', 'JSON', 'Math', 'Date', 'Intl',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigUint64Array', 'BigInt64Array',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'escape', 'unescape',
  // 宿主注入（微信运行时 / CommonJS 模块包装）
  'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'TextEncoder', 'TextDecoder',
  'require', 'module', 'exports',
  'wx', 'getCurrentPages', 'getApp', 'App', 'Page', 'Component', 'Behavior', 'getRegExp',
  'requirePlugin', // 微信宿主注入（插件加载）
  'tt',            // Taro 多端适配里抖音端的引用，weapp 构建不会执行该分支
])

// 应用自己 polyfill 的全局（src/polyfills.ts 运行时补齐），扫描器无法看到赋值，手动登记
const APP_POLYFILLED = new Set(['fetch', 'Request', 'Headers', 'Response', 'AbortController'])

// 白名单外但确认安全的名字：来源代码有别的防护或分支不会执行，静态扫不出来，逐个登记理由
const IGNORED_GLOBALS = new Map([
  ['localStorage', 'better-auth 会话广播 fallback，调用包在 try/catch 里，ReferenceError 会被吞掉'],
  ['btoa', 'better-fetch 的 HTTP Basic 认证分支，本项目请求从不配置 Basic 认证，不会执行'],
])

function* walkJs(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) yield* walkJs(p)
    else if (name.name.endsWith('.js')) yield p
  }
}

let syntaxHits = 0
let globalHits = 0
for (const file of walkJs(join(appDir, 'dist'))) {
  const code = readFileSync(file, 'utf8')
  const ast = parser.parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true })
  const syntax = []
  const undeclared = new Map() // name -> 首次节点
  // 先收集 typeof X 出现过的名字：typeof 对未声明变量不抛错，作者写过 typeof
  // 说明知道该全局可能缺失（守卫式引用）；同文件的裸引用也一并放过（宽松口径：
  // 名字要么整个环境有要么没有，探测过即视为已防护）
  const typeofNames = new Set()
  traverse(ast, {
    UnaryExpression(path) {
      if (path.node.operator === 'typeof' && path.node.argument.type === 'Identifier') {
        typeofNames.add(path.node.argument.name)
      }
    },
  })
  traverse(ast, {
    // traverse 的 enter 收到的是 path 包装对象，真正的节点在 path.node
    enter(path) {
      const node = path.node
      if (BAD_TYPES.has(node.type)) syntax.push(node)
      else if (node.type === 'AssignmentExpression' && BAD_ASSIGN.has(node.operator)) syntax.push(node)
      else if (node.type === 'Identifier' && path.isReferencedIdentifier()) {
        // 作用域链里没声明、也不在各名单里 => 运行时去宿主全局找，小程序多半没有
        if (
          !path.scope.hasBinding(node.name) && !typeofNames.has(node.name) &&
          !DECLARED_GLOBALS.has(node.name) && !APP_POLYFILLED.has(node.name) &&
          !IGNORED_GLOBALS.has(node.name) && !undeclared.has(node.name)
        ) {
          undeclared.set(node.name, node)
        }
      }
    },
  })
  for (const node of syntax.slice(0, 10)) {
    const at = node.start ?? 0
    const loc = node.loc?.start ? `${node.loc.start.line}:${node.loc.start.column + 1}` : '?'
    const label = node.type === 'AssignmentExpression' ? `逻辑赋值 ${node.operator}` : node.type
    console.log(`[语法] ${file} ${loc} ${label}`)
    console.log('  片段:', JSON.stringify(code.slice(Math.max(0, at - 70), at + 90)))
    syntaxHits++
  }
  if (syntax.length > 10) console.log(`[语法] ${file} …另有 ${syntax.length - 10} 处未展开`)
  for (const [name, node] of undeclared) {
    const at = node.start ?? 0
    const loc = node.loc?.start ? `${node.loc.start.line}:${node.loc.start.column + 1}` : '?'
    console.log(`[未声明全局] ${file} ${loc} ${name}`)
    console.log('  片段:', JSON.stringify(code.slice(Math.max(0, at - 70), at + 90)))
    globalHits++
  }
}
console.log(`--- 语法 ${syntaxHits} 处，未声明全局 ${globalHits} 处（均 0 即通过）`)
