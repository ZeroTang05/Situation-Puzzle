/**
 * 会话状态：vanilla 客户端没有 useSession，这里自建（对齐 web 端 useJevSession 的产出）。
 * 三条刷新路径：挂载时拉一次；其它页面登录/登出后经 eventCenter 广播；页面 onShow
 * （从登录页返回、从后台切回）时重拉。昵称权威值在 /me，页面自行查询。
 */
import { useCallback, useEffect, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { authClient } from '../api/auth-client'

/** Better Auth 会话数据的最小投影（与 apps/web/src/session.ts 同形） */
export interface Session {
  user: { id: string; email: string; name: string; emailVerified: boolean }
  session: { id: string; userId: string; expiresAt: string | Date }
}

const SESSION_EVENT = 'jev:session-changed'

/** 登录 / 登出完成后调用：让所有已挂载页面的会话 hook 立即重拉 */
export function notifySessionChanged(): void {
  Taro.eventCenter.trigger(SESSION_EVENT)
}

export function useJevSession(): { session: Session | null; isPending: boolean } {
  const [session, setSession] = useState<Session | null>(null)
  const [isPending, setIsPending] = useState(true)

  const refresh = useCallback(async () => {
    // 无会话时接口返回 401，better-auth 把它折叠成 data: null（不算错误）；
    // 网络失败（域名未配等）getSession 会整体 reject，按无会话处理
    const { data } = await authClient.getSession().catch(() => ({ data: null, error: null }))
    // 形状闸门：data 有 user 才算有效会话；异常形状当无会话并留痕（定位用）
    if (data && typeof data === 'object' && 'user' in data) {
      setSession(data as unknown as Session)
    } else {
      if (data) console.warn('[session] 异常会话形状，按未登录处理:', JSON.stringify(data).slice(0, 200))
      setSession(null)
    }
    setIsPending(false)
  }, [])

  useEffect(() => {
    void refresh()
    Taro.eventCenter.on(SESSION_EVENT, refresh)
    return () => {
      Taro.eventCenter.off(SESSION_EVENT, refresh)
    }
  }, [refresh])

  useDidShow(() => {
    void refresh()
  })

  return { session, isPending }
}
