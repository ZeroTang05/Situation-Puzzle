import './polyfills'
import type { PropsWithChildren } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './state/query-client'
import './app.css'

/** 应用根组件：Taro 约定的壳，children 即当前页面。 */
function App({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

export default App
