/// <reference types="@tarojs/taro" />

// config/ 里的环境判断用；小程序侧没有 @types/node
declare const process: {
  env: Record<string, string | undefined>
}

// 静态资源经 webpack url-loader 处理，import 进来是资源路径字符串
declare module '*.png' {
  const path: string
  export default path
}

declare module '*.jpg' {
  const path: string
  export default path
}
