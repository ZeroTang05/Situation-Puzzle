/**
 * Taro 构建配置：webpack5 + React，只编译微信小程序端（weapp）。
 * designWidth 375：样式里写的 px 与 web 端 CSS px 一一对应（16px 正文 / 44px 触控），
 * pxtransform 自动换算 rpx，一比一移植样式时不用换算。
 */
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'

/** webpack-chain 的链式 API：每个方法都返回自身，这里写最小自引用结构供类型标注 */
interface LegacyUse {
  loader: (loaderPath: string) => LegacyUse
  options: (opts: object) => LegacyUse
}

/** webpack-chain 规则的最小结构类型（只服务下方 .mjs 兜底规则的类型标注） */
interface LegacyRule {
  test: (pattern: RegExp) => LegacyRule
  include: { add: (item: string) => void }
  use: (name: string) => LegacyUse
}

/** 仓库根目录：config/ 往上三级；workspace 包的 TS 源码真实路径都在这下面 */
const repoRoot = path.resolve(__dirname, '..', '..', '..')

/**
 * 解析依赖的真实根目录（.pnpm/<hash>/node_modules/<pkg>）。
 * 这些包发布 ES2022 class 私有字段（#field），微信预览器解析即报 Invalid token，
 * 必须圈进 Taro 的 babel 做语法降级。compile.include 只收字符串路径，
 * pnpm 真实路径带哈希没法写死，配置加载时动态解析。
 * 坑：很多包的 exports 不暴露 ./package.json 子路径（直接 resolve 会抛
 * ERR_PACKAGE_PATH_NOT_EXPORTED），改成解析主入口后向上走找包根；
 * 传递依赖（query-core、@better-auth/core）在 app 目录解析不到，
 * 要从依赖它们的包的真实目录出发解析。
 */
function pkgRoot(fromDir: string, id: string): string {
  const entry = require.resolve(id, { paths: [fromDir] })
  let dir = path.dirname(entry)
  while (dir !== path.parse(dir).root) {
    if (existsSync(path.join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === id) return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error(`找不到依赖包根目录: ${id}（入口 ${entry}）`)
}

const appDir = path.resolve(__dirname, '..')
const reactQueryRoot = pkgRoot(appDir, '@tanstack/react-query')
const queryCoreRoot = pkgRoot(reactQueryRoot, '@tanstack/query-core')
const betterAuthRoot = pkgRoot(appDir, 'better-auth')
const betterAuthCoreRoot = pkgRoot(betterAuthRoot, '@better-auth/core')
const betterCallRoot = pkgRoot(betterAuthRoot, 'better-call')
const taroRoot = pkgRoot(appDir, '@tarojs/taro')
const nanostoresRoot = pkgRoot(taroRoot, 'nanostores')
/** 语法降级清单：react-query 核心（Query/Observer 私有字段）、better-auth 客户端链
 *  （better-call 的 error.mjs、@better-auth/core 的 env 模块都发 #field）、
 *  nanostores（Taro 传递依赖，发逻辑赋值 ||=，ES2021）；
 *  真实路径为主，符号链接路径兜底 */
const legacySyntaxPaths = [
  reactQueryRoot,
  queryCoreRoot,
  betterAuthRoot,
  betterAuthCoreRoot,
  betterCallRoot,
  nanostoresRoot,
  path.join(appDir, 'node_modules', '@tanstack', 'react-query'),
  path.join(appDir, 'node_modules', 'better-auth'),
]

export default defineConfig(async (merge) => {
  const baseConfig: UserConfigExport = {
    projectName: 'miniprogram',
    date: '2026-10-25',
    designWidth: 375,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2, 828: 1.81 / 2 },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    framework: 'react',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    mini: {
      // .mjs 兜底转译：compile.include 挂的脚本规则对 .js 生效、对 .mjs 实测不生效
      // （better-call / @better-auth/core 只发 .mjs，带 ES2022 class 私有字段 #field，
      // 微信预览器解析即报 Invalid token）。这里给同一批包的 .mjs 单独挂 babel。
      // 关键坑：babel-loader 不带 options 时按「被编译文件」的位置向上找配置，
      // .pnpm 深处的文件找不到应用的 babel.config.js，等于零预设空转；
      // 必须 cwd + configFile 显式指到应用根，走 preset-taro 与 src 同一套降级口径。
      webpackChain(chain: {
        module: { rule: (name: string) => LegacyRule }
      }) {
        const rule = chain.module.rule('legacy-syntax-mjs').test(/\.mjs$/)
        for (const p of legacySyntaxPaths) rule.include.add(p)
        rule.use('babel')
          .loader(require.resolve('babel-loader', { paths: [appDir] }))
          .options({ cwd: appDir, configFile: path.resolve(appDir, 'babel.config.js') })
      },
      // @jev/contracts 与 @jev/i18n 是 workspace TS 源码导出（无构建产物）。
      // pnpm 下有两个可见路径：应用内符号链接 node_modules/@jev/* 与仓库真实路径
      // packages/*；webpack 解析符号链接的开关不可控，两个都圈进编译范围
      compile: {
        include: [
          path.join(repoRoot, 'packages', 'contracts'),
          path.join(repoRoot, 'packages', 'i18n'),
          path.resolve(__dirname, '..', 'node_modules', '@jev', 'contracts'),
          path.resolve(__dirname, '..', 'node_modules', '@jev', 'i18n'),
          // 语法降级清单的真实路径在上方 legacySyntaxPaths 里动态解析（见函数注释）
          ...legacySyntaxPaths,
        ]
      },
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false }
      }
    },
    h5: {}
  }

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig)
  }
  return merge({}, baseConfig, prodConfig)
})
