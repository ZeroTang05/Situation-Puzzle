import './polyfills'
import type { PropsWithChildren, ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './state/query-client'
import './app.css'

/**
 * 应用根组件：Taro 约定的壳，children 即当前页面。
 * 注意：Taro 小程序端 app.tsx 自身渲染的兄弟节点不会上屏，弹窗宿主（DialogHost）
 * 不能挂在这里 —— 每个用到 useDialog 的页面都要自己挂一个页内的。
 */
function App({ children }: PropsWithChildren): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

export default App
