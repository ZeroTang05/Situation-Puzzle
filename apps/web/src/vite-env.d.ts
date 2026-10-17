/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** App 壳构建的接口基址（如 https://sp.xiaobaozi.cn）；网页构建不设置，走相对路径 */
  readonly VITE_API_BASE_URL?: string;
}
