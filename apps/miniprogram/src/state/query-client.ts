/**
 * 全局唯一 QueryClient 实例：页面里 useQuery/useMutation 的缓存与失效都归它管。
 * 放独立模块而非 app.tsx——Taro 应用入口经 webpack 特殊编译，从它导入值会丢
 * （ModuleDependencyWarning: module has no exports）。
 */
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // 小程序没有窗口聚焦事件，关掉避免无意义的后台重拉
      refetchOnWindowFocus: false,
    },
  },
})
