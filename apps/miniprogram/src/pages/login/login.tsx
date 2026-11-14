/**
 * 登录页（小程序版，框架对齐 apps/web/src/auth/login-page.tsx）：
 * 微信一键登录。流程：Taro.login() 拿 5 分钟临时 code → POST /auth/wechat-mini/login →
 * 服务端 code2session 换 openid 并建号/建会话，令牌在响应体返回，本地存为 Bearer 令牌。
 * 首次登录自动创建账号（昵称由服务端默认生成）；邮箱登录/注册/找回密码不提供——
 * 微信身份即账号，无密码可忘。语言切换入口与 web 登录页同位（topbar 右侧）。
 * 登录成功后广播会话变更并返回来源页（页面栈空则回首页）。
 */
import { useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Image, Text, View } from '@tarojs/components'
import { AuthError, loginWithWechat } from '../../api/auth-client'
import { useLanguage } from '../../state/language'
import { notifySessionChanged } from '../../state/session'
import { goBack } from '../../ui/back'
import { displayAuthError } from '@jev/i18n'
import iconPng from '../../assets/icon.png'

/** 登录完成后的去向：有页面栈就返回来源页（来源页 onShow 会重拉会话），否则回首页 */
function finishLogin(): void {
  notifySessionChanged()
  const pages = Taro.getCurrentPages()
  if (pages.length > 1) void Taro.navigateBack()
  else void Taro.reLaunch({ url: '/pages/index/index' })
}

/** 带着「已翻译文案」的错误：只有这类错误的信息适合直接展示给用户 */
class LoginError extends Error {}

export default function Login(): ReactNode {
  const { copy, language, setLanguage } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wechatLogin = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { code } = await Taro.login()
      if (!code) throw new LoginError(copy.wechatLoginFail)
      await loginWithWechat(code)
      finishLogin()
    } catch (err) {
      // 只展示已翻译的文案；意外异常（网络失败/解析错误）不把英文原文甩给用户
      if (err instanceof AuthError) {
        // better-auth 错误体按 code 翻译；未知 code 回落通用文案
        setError(displayAuthError(err.code, language, copy.wechatLoginFail))
      } else {
        setError(err instanceof LoginError ? err.message : copy.wechatLoginFail)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="page">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
          {copy.back}
        </Button>
        <View className="brand brand-identity">
          <Image className="brand-mark" src={iconPng} />
          <Text>{copy.brand}</Text>
        </View>
        <Button
          className="btn btn-sm btn-ghost lang-switch topbar-tail"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
        >
          {language === 'zh' ? copy.languageSwitchToEn : copy.languageSwitchToZh}
        </Button>
      </View>

      <View className="panel stack">
        <Text className="h2">{copy.signin}</Text>
        <Button className="btn btn-primary" disabled={busy} onClick={() => void wechatLogin()}>
          {copy.wechatLogin}
        </Button>
        <Text className="muted wechat-login-hint">{copy.wechatLoginHint}</Text>
        {error && <Text className="error-text">{error}</Text>}
        <Button
          className="link-btn"
          onClick={() => void Taro.navigateTo({ url: '/pages/privacy/privacy' })}
        >
          {language === 'zh' ? '隐私政策' : 'Privacy Policy'}
        </Button>
      </View>
    </View>
  )
}
