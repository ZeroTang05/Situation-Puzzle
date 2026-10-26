import type { UserConfigExport } from '@tarojs/cli'

/** 开发构建：打印完整日志便于排错 */
export default {
  logger: {
    quiet: false,
    stats: true
  },
  mini: {},
  h5: {}
} satisfies UserConfigExport
