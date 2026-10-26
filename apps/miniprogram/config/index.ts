/**
 * Taro 构建配置：webpack5 + React，只编译微信小程序端（weapp）。
 * designWidth 375：样式里写的 px 与 web 端 CSS px 一一对应（16px 正文 / 44px 触控），
 * pxtransform 自动换算 rpx，一比一移植样式时不用换算。
 */
import path from 'node:path'
import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'

/** 仓库根目录：config/ 往上三级；workspace 包的 TS 源码真实路径都在这下面 */
const repoRoot = path.resolve(__dirname, '..', '..', '..')

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
      // @jev/contracts 与 @jev/i18n 是 workspace TS 源码导出（无构建产物）。
      // pnpm 下有两个可见路径：应用内符号链接 node_modules/@jev/* 与仓库真实路径
      // packages/*；webpack 解析符号链接的开关不可控，两个都圈进编译范围
      compile: {
        include: [
          path.join(repoRoot, 'packages', 'contracts'),
          path.join(repoRoot, 'packages', 'i18n'),
          path.resolve(__dirname, '..', 'node_modules', '@jev', 'contracts'),
          path.resolve(__dirname, '..', 'node_modules', '@jev', 'i18n'),
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
