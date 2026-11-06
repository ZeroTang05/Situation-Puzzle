import './polyfills'
import type { PropsWithChildren, ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './state/query-client'
import { DialogHost } from './ui/dialog'
import './app.css'

/** 应用根组件：Taro 约定的壳，children 即当前页面；弹窗宿主盖在页面之上。 */
function App({ children }: PropsWithChildren): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <DialogHost />
    </QueryClientProvider>
  )
}

export default App
