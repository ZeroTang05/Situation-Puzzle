/**
 * 首页（代码级对齐 apps/web/src/lobby/home-page.tsx）：
 * topbar 品牌区（图标 + 问号玩法入口 + 登录态入口）、hero 卡（主入口单人 / 多人，
 * 次要入口题库 / 大厅）、登录后显示开房额度行、玩法介绍走深海弹窗。
 * 小程序差异：多人房间 / 大厅在多人里程碑接入前点按提示「即将开放」；
 * 通知铃铛随社交里程碑接入。
 * 邀请链路：分享链接 ?ref= 进站捕获邀请码（页面参数 + 启动参数双来源），登录后自动领取。
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Button, Image, Text, View } from '@tarojs/components'
import { api } from '../../api/client'
import { useLanguage } from '../../state/language'
import { useJevSession } from '../../state/session'
import { captureInviteRef, claimInviteRefOnce } from '../../invite/invite-ref'
import { useInviteShare } from '../../invite/share'
import { Modal } from '../../ui/dialog'
import iconPng from '../../assets/icon.png'

export default function Index(): ReactNode {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const router = useRouter()
  const [introOpen, setIntroOpen] = useState(false)
  const comingSoon = language === 'zh' ? '即将开放' : 'Coming soon'

  // 分享链接进入：页面参数与启动参数都可能是携带点，合法的邀请码才落本地
  captureInviteRef(router.params)
  captureInviteRef(Taro.getEnterOptionsSync().query)
  // 每次回到前台重试领取：覆盖「未登录进站 → 登录返回首页」的路径
  useDidShow(() => {
    void claimInviteRefOnce(session !== null)
  })
  useInviteShare()

  // 开房额度：与 web 首页同源接口（未登录不拉）
  const entitlement = useQuery({
    queryKey: ['entitlement-preview'],
    queryFn: () => api<{ sponsored: boolean; freeRemaining: number }>('/rooms/entitlement-preview'),
    enabled: session !== null,
    retry: false,
  })

  const openLater = () => {
    void Taro.showToast({ title: comingSoon, icon: 'none', duration: 1200 })
  }

  return (
    <View className="page">
      <View className="topbar">
        <View className="brand brand-identity">
          <Image className="brand-mark" src={iconPng} />
          <Text>{copy.brand}</Text>
        </View>
        <View className="topbar-actions">
          <Button className="btn btn-ghost btn-sm help-btn" onClick={() => setIntroOpen(true)}>?</Button>
          {session ? (
            <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateTo({ url: '/pages/me/me' })}>
              {copy.me}
            </Button>
          ) : (
            <Button className="btn btn-sm" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
              {copy.login}
            </Button>
          )}
        </View>
      </View>

      <View className="hero-card">
        <Text className="accent tagline">{copy.tagline}</Text>
        <View className="hero-actions">
          <Button className="btn btn-primary btn-lg" onClick={() => void Taro.navigateTo({ url: '/pages/library/library' })}>
            {copy.solo}
          </Button>
          <Button className="btn btn-lg" onClick={openLater}>{copy.multi}</Button>
        </View>
        {/* 次要入口单独一行小按钮：主次分明 */}
        <View className="hero-secondary">
          <Button className="btn btn-sm" onClick={() => void Taro.navigateTo({ url: '/pages/library/library' })}>
            {copy.library}
          </Button>
          <Button className="btn btn-sm" onClick={openLater}>
            {copy.hall}
          </Button>
        </View>
      </View>

      {session && entitlement.data && (
        <View className="panel entitlement-row">
          <Text className="muted">{copy.freeRooms}</Text>
          <Text className="entitlement-value">
            {entitlement.data.sponsored ? copy.unlimited : `${entitlement.data.freeRemaining} / 10`}
          </Text>
          {entitlement.data.sponsored && <Text className="verdict-badge verdict-solved">{copy.sponsored}</Text>}
        </View>
      )}

      <Modal open={introOpen} onClose={() => setIntroOpen(false)} title={copy.howToPlay} closeLabel={copy.gotIt}>
        <Text className="p">{copy.introWhat}</Text>
        <Text className="p">{copy.introGoal}</Text>
        <Text className="p">{copy.introAdvice}</Text>
      </Modal>
    </View>
  )
}
