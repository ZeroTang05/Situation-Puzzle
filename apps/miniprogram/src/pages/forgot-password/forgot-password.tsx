/**
 * 忘记密码：输入注册邮箱 → 发送重置邮件；成功后只展示统一提示（防账号枚举）。
 * 重置链接落回网页版 /reset-password：邮件里的链接只能在外部浏览器打开，
 * 小程序无法用深链承接 token，设置新密码这步在网页完成。
 */
import { useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Input, Text, View } from '@tarojs/components'
import { authClient } from '../../api/auth-client'
import { API_BASE } from '../../api/client'
import { useLanguage } from '../../state/language'
import { displayAuthError } from '@jev/i18n'

export default function ForgotPassword() {
  const { copy, language } = useLanguage()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const { error: resetError } = await authClient.requestPasswordReset({
      email,
      // 重置邮件里的链接落回网页版的重置页（邮箱链接在浏览器打开）
      redirectTo: `${API_BASE}/reset-password`,
    })
    setBusy(false)
    if (resetError) {
      setError(displayAuthError(resetError.code, language, copy.sendCodeFail))
      return
    }
    setSent(true)
  }

  return (
    <View className="page">
      <View className="topbar">
        <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.brand}</Text>
      </View>
      <View className="panel stack">
        <Text className="h2">{copy.forgotPasswordTitle}</Text>
        {sent ? (
          <View className="stack">
            <Text className="muted">{copy.resetEmailSent}</Text>
            <Button
              className="btn btn-primary"
              onClick={() => void Taro.navigateBack()}
            >
              {copy.backToLogin}
            </Button>
          </View>
        ) : (
          <View className="stack">
            <Text className="muted">{copy.forgotPasswordPrompt}</Text>
            <View className="field-label">
              <Text>{copy.emailField}</Text>
              <Input
                className="field"
                type="text"
                value={email}
                onInput={(e) => setEmail(e.detail.value)}
                placeholder={copy.emailField}
              />
            </View>
            <Button
              className="btn btn-primary"
              disabled={busy || !email.includes('@')}
              onClick={() => void submit()}
            >
              {copy.sendResetEmail}
            </Button>
          </View>
        )}
        {error && <Text className="error-text">{error}</Text>}
      </View>
    </View>
  )
}
