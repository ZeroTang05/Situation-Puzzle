/**
 * 登录页（小程序版）：微信一键登录。
 * 流程：Taro.login() 拿 5 分钟临时 code → POST /auth/wechat-mini/login →
 * 服务端 code2session 换 openid 并建号/建会话，令牌在响应体返回，本地存为 Bearer 令牌。
 * 首次登录自动创建账号（昵称由服务端默认生成）；邮箱登录/注册/找回密码不提供——
 * 微信身份即账号，无密码可忘。
 * 登录成功后广播会话变更并返回来源页（页面栈空则回首页）。
 */
import { useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { API_BASE, storeBearerToken } from '../../api/client'
import { taroFetch } from '../../api/fetch-adapter'
import { useLanguage } from '../../state/language'
import { notifySessionChanged } from '../../state/session'
import { displayAuthError } from '@jev/i18n'

/** 登录完成后的去向：有页面栈就返回来源页（来源页 onShow 会重拉会话），否则回首页 */
function finishLogin(): void {
  notifySessionChanged()
  const pages = Taro.getCurrentPages()
  if (pages.length > 1) void Taro.navigateBack()
  else void Taro.reLaunch({ url: '/pages/index/index' })
}

export default function Login() {
  const { copy, language, setLanguage } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wechatLogin = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { code } = await Taro.login()
      if (!code) throw new Error('Taro.login 未返回 code')
      const res = await taroFetch(`${API_BASE}/api/v1/auth/wechat-mini/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const payload = (await res.json()) as { token?: string; error?: { code?: string }; code?: string }
      if (!res.ok || !payload.token) {
        // better-auth 错误体按 code 翻译；未知形态回落通用文案
        throw new Error(displayAuthError(payload.error?.code ?? payload.code ?? null, language, copy.wechatLoginFail))
      }
      storeBearerToken(payload.token)
      finishLogin()
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Taro.login 未返回 code'
        ? err.message
        : copy.wechatLoginFail)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="page">
      <View className="topbar">
        <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.brand}</Text>
        <Button
          className="btn btn-ghost btn-sm lang-switch"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
        >
          {language === 'zh' ? copy.languageSwitchToEn : copy.languageSwitchToZh}
        </Button>
      </View>

      <View className="panel stack wechat-login-panel">
        <Text className="h2">{copy.brand}</Text>
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
