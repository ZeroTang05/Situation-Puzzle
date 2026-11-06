/**
 * 会话状态：vanilla 客户端没有 useSession，这里自建（对齐 web 端 useJevSession 的产出）。
 * 三条刷新路径：挂载时拉一次；其它页面登录/登出后经 eventCenter 广播；页面 onShow
 * （从登录页返回、从后台切回）时重拉。昵称权威值在 /me，页面自行查询。
 */
import { useCallback, useEffect, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { getSession, type AuthSession } from '../api/auth-client'

/** Better Auth 会话数据的最小投影（与 apps/web/src/session.ts 同形） */
export type Session = AuthSession

const SESSION_EVENT = 'jev:session-changed'

/** 登录 / 登出完成后调用：让所有已挂载页面的会话 hook 立即重拉 */
export function notifySessionChanged(): void {
  Taro.eventCenter.trigger(SESSION_EVENT)
}

export function useJevSession(): { session: Session | null; isPending: boolean } {
  const [session, setSession] = useState<Session | null>(null)
  const [isPending, setIsPending] = useState(true)

  const refresh = useCallback(async () => {
    // 无有效令牌时服务端回 null（HTTP 200），按未登录处理；
    // 网络失败（域名未配等）整体 reject，同样按无会话处理
    const data = await getSession().catch(() => null)
    setSession(data)
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
