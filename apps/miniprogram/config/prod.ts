import type { UserConfigExport } from '@tarojs/cli'

/** 生产构建：上传/提审用。临时开 sourceMap 定位真机渲染报错（定位后移除） */
export default {
  mini: {
    webpackChain(chain) {
      chain.devtool('source-map')
    }
  },
  h5: {}
} satisfies UserConfigExport
