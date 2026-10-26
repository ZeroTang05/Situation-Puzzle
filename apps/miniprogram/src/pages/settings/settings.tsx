/**
 * 设置页：个人资料（昵称）、界面语言、兑换码、关于（隐私政策）、退出登录。
 * 结构与 apps/web/src/settings/settings-page.tsx 一致；差异只有两处——
 * 退出确认用微信原生对话框（Taro.showModal），页面跳转换 Taro 导航。
 * 语言切换只在这里和登录页开放，改完写进本地存储，每个请求经
 * X-Jev-Language 头上报（服务端据此分流邮件语言）。
 */
import { useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Input, Text, View } from '@tarojs/components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, translateApiError } from '../../api/client'
import { signOut } from '../../api/auth-client'
import { useLanguage } from '../../state/language'
import { notifySessionChanged } from '../../state/session'
import type { Language } from '@jev/i18n'

interface MeResponse {
  userId: string
  nickname: string
  email: string
}

interface RedeemResponse {
  orderId: string
  status: string
}

/** 兑换码表单：输入运营方发的码，服务端核销并发放会员权益 */
function RedeemSection() {
  const { copy, language } = useLanguage()
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeDone, setCodeDone] = useState(false)
  const [redeeming, setRedeeming] = useState(false)

  const submitCode = async () => {
    const value = code.trim()
    if (value.length < 6) {
      setCodeDone(false)
      setCodeError(copy.redeemCodeFailed)
      return
    }
    setRedeeming(true)
    setCodeError(null)
    try {
      await api<RedeemResponse>('/orders/redeem', { method: 'POST', body: { code: value } })
      setCodeDone(true)
      setCode('')
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setCodeDone(false)
      setCodeError(translateApiError(err, language, copy.sponsorRedeemUnavailable))
    } finally {
      setRedeeming(false)
    }
  }

  return (
    <View>
      <View className="sponsor-redeem-row">
        <Input
          className="field sponsor-redeem-input"
          type="text"
          value={code}
          onInput={(e) => {
            setCode(e.detail.value)
            setCodeDone(false)
          }}
          placeholder={copy.redeemCodePlaceholder}
        />
        <Button className="btn btn-primary btn-sm" disabled={redeeming} onClick={() => void submitCode()}>
          {copy.redeemCodeSubmit}
        </Button>
      </View>
      {codeError && <Text className="error-text">{codeError}</Text>}
      {codeDone && <Text className="ok-text">{copy.redeemCodeSuccess}</Text>}
    </View>
  )
}

export default function Settings() {
  const { copy, language, setLanguage } = useLanguage()
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), retry: false })

  const startEdit = () => {
    setDraft(me.data?.nickname ?? '')
    setError(null)
    setNotice(null)
    setEditing(true)
  }

  const saveNickname = async () => {
    const nickname = draft.trim()
    if (nickname.length === 0 || saving) return
    setSaving(true)
    setError(null)
    try {
      await api<{ nickname: string }>('/me/nickname', { method: 'PATCH', body: { nickname } })
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      setEditing(false)
      setNotice(copy.nicknameUpdated)
    } catch (err) {
      setError(translateApiError(err, language, copy.saveFail))
    } finally {
      setSaving(false)
    }
  }

  /** 退出登录走微信原生对话框二次确认，避免误触 */
  const logout = async () => {
    const { confirm } = await Taro.showModal({ title: copy.logout, content: copy.logoutConfirm })
    if (!confirm) return
    await signOut()
    queryClient.clear()
    notifySessionChanged()
    void Taro.reLaunch({ url: '/pages/index/index' })
  }

  const pickLanguage = (next: Language) => {
    if (next === language) return
    setLanguage(next)
  }

  return (
    <View className="page">
      <View className="topbar">
        <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.settingsTitle}</Text>
      </View>

      {/* 个人资料：昵称可改，邮箱只读 */}
      <View className="panel stack">
        <Text className="h3">{copy.settingsProfile}</Text>
        <View className="settings-row">
          <Text className="muted">{copy.nickname}</Text>
          {!editing && (
            <View className="settings-value">
              <Text>{me.data?.nickname ?? (me.isPending ? '…' : '—')}</Text>
              <Button className="btn btn-ghost btn-sm" onClick={startEdit}>
                {copy.modify}
              </Button>
            </View>
          )}
        </View>

        {editing && (
          <View className="stack">
            <View className="field-label">
              <Text className="muted">{copy.nickname}</Text>
              <Input
                className="field"
                type="text"
                value={draft}
                maxlength={30}
                onInput={(e) => setDraft(e.detail.value)}
              />
              <Text className="field-help muted">{copy.nicknameRule}</Text>
            </View>
            <View className="me-edit-actions">
              <Button
                className="btn btn-sm btn-primary"
                disabled={saving || draft.trim().length === 0}
                onClick={() => void saveNickname()}
              >
                {saving ? copy.submitting : copy.saved}
              </Button>
              <Button className="btn btn-sm" disabled={saving} onClick={() => setEditing(false)}>
                {copy.cancelEdit}
              </Button>
            </View>
          </View>
        )}

        <View className="settings-row">
          <Text className="muted">{copy.emailField}</Text>
          <Text className="settings-value">{me.data?.email ?? '—'}</Text>
        </View>

        {error && <Text className="error-text">{error}</Text>}
        {notice && <Text className="ok-text">{notice}</Text>}
        {me.isError && (
          <Text className="error-text">{translateApiError(me.error, language, copy.accountLoadFail)}</Text>
        )}
      </View>

      {/* 界面语言：与登录页并列的两个入口 */}
      <View className="panel stack">
        <Text className="h3">{copy.settingsLanguage}</Text>
        <View className="settings-lang">
          <Button
            className={'btn btn-sm' + (language === 'zh' ? ' btn-primary' : '')}
            onClick={() => pickLanguage('zh')}
          >
            {copy.languageChinese}
          </Button>
          <Button
            className={'btn btn-sm' + (language === 'en' ? ' btn-primary' : '')}
            onClick={() => pickLanguage('en')}
          >
            {copy.languageEnglish}
          </Button>
        </View>
      </View>

      {/* 兑换码：运营发码后在此兑换会员 */}
      <View className="panel stack">
        <Text className="h3">{copy.redeemCodeTitle}</Text>
        <RedeemSection />
      </View>

      {/* 关于：隐私政策 */}
      <View className="panel stack">
        <Text className="h3">{language === 'zh' ? '关于' : 'About'}</Text>
        <Button
          className="btn"
          onClick={() => void Taro.navigateTo({ url: '/pages/privacy/privacy' })}
        >
          {language === 'zh' ? '隐私政策' : 'Privacy Policy'}
        </Button>
      </View>

      {/* 账号：退出登录 */}
      <View className="panel stack">
        <Text className="h3">{copy.settingsAccount}</Text>
        <Button className="btn me-logout" onClick={() => void logout()}>
          {copy.logout}
        </Button>
      </View>
    </View>
  )
}
