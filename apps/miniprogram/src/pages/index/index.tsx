/**
 * 首页：品牌区 + 主入口（单人 / 多人）+ 次要入口 + 登录态入口。
 * 单人 → 题库挑题开局（与 web 首页同构）；多人/大厅在后续里程碑接通。
 * 顶栏右侧按会话状态给「登录」或「我的」。
 *
 * 邀请链路入口：从分享链接 ?ref= 进站时捕获邀请码（页面参数 + 启动参数双来源），
 * 登录后自动领取；本页分享路径带当前用户邀请码。
 */
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { useLanguage } from '../../state/language'
import { useJevSession } from '../../state/session'
import { captureInviteRef, claimInviteRefOnce } from '../../invite/invite-ref'
import { useInviteShare } from '../../invite/share'
import './index.css'

export default function Index() {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const router = useRouter()
  const comingSoon = language === 'zh' ? '即将开放' : 'Coming soon'

  // 分享链接进入：页面参数与启动参数都可能是携带点，合法的邀请码才落本地
  captureInviteRef(router.params)
  captureInviteRef(Taro.getEnterOptionsSync().query)
  // 每次回到前台重试领取：覆盖「未登录进站 → 登录返回首页」的路径
  useDidShow(() => {
    void claimInviteRefOnce(session !== null)
  })
  useInviteShare()

  const openLater = () => {
    void Taro.showToast({ title: comingSoon, icon: 'none', duration: 1200 })
  }

  return (
    <View className="page">
      <View className="topbar">
        <Text className="brand">{copy.brand}</Text>
        <View className="topbar-actions">
          <Button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              session
                ? void Taro.navigateTo({ url: '/pages/me/me' })
                : void Taro.navigateTo({ url: '/pages/login/login' })
            }
          >
            {session ? copy.me : copy.login}
          </Button>
          <Button className="btn btn-ghost btn-sm help-btn" onClick={openLater}>?</Button>
        </View>
      </View>

      <View className="hero-card">
        <Text className="accent tagline">{copy.tagline}</Text>
        <View className="hero-actions">
          <Button
            className="btn btn-primary btn-lg"
            onClick={() => void Taro.navigateTo({ url: '/pages/library/library' })}
          >
            {copy.solo}
          </Button>
          <Button className="btn btn-lg" onClick={openLater}>{copy.multi}</Button>
        </View>
        <View className="hero-secondary">
          <Button
            className="btn"
            onClick={() => void Taro.navigateTo({ url: '/pages/library/library' })}
          >
            {copy.library}
          </Button>
          <Button className="btn" onClick={openLater}>{copy.hall}</Button>
        </View>
      </View>
    </View>
  )
}
