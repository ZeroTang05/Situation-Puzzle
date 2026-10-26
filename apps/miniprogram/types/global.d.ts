/// <reference types="@tarojs/taro" />

// config/ 里的环境判断用；小程序侧没有 @types/node
declare const process: {
  env: Record<string, string | undefined>
}
