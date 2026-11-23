/**
 * 设置页（代码级对齐 apps/web/src/settings/settings-page.tsx）：
 * 个人资料（昵称）、界面语言、兑换码、关于（隐私政策）、退出登录。
 * 语言切换只在这里和登录页开放，改完写进本地存储，每个请求经
 * X-Jev-Language 头上报（服务端据此分流邮件语言）。
 * 与 web 差异只有交互载体：退出确认走深海弹窗（useDialog），页面跳转换 Taro 导航。
 */
import { useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Input, Text, View } from '@tarojs/components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, translateApiError } from '../../api/client'
import { signOut } from '../../api/auth-client'
import { useLanguage } from '../../state/language'
import { notifySessionChanged, useJevSession } from '../../state/session'
import { clearRoomLocal } from '../../pkg-room/room/room-local'
import { goBack } from '../../ui/back'
import { LoginPrompt } from '../../ui/login-prompt'
import { DialogHost, Modal, useDialog } from '../../ui/dialog'
import type { Language } from '@jev/i18n'
import { profileIdentityRows, type MeResponse } from '@jev/contracts'

import { BindEmailSection } from './bind-email-section'

export default function Settings(): ReactNode {
  const { copy, language, setLanguage } = useLanguage()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const { session } = useJevSession()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedIdentity, setSelectedIdentity] = useState<{ label: string; value: string } | null>(null)

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), retry: false })
  const identities = me.data ? profileIdentityRows(me.data) : []

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

  /** 退出登录走二次确认（深海弹窗，与 web useDialog.confirm 同款），避免误触 */
  const logout = async () => {
    if (!(await dialog.confirm(copy.logoutConfirm, copy.logout))) return
    // 对齐 web settings-page：登出时清掉本账号各房间的本地草稿/待发队列
    const userId = session?.user?.id
    if (userId) await clearRoomLocal(userId)
    await signOut()
    queryClient.clear()
    notifySessionChanged()
    void Taro.reLaunch({ url: '/pages/index/index' })
  }

  const pickLanguage = (next: Language) => {
    if (next === language) return
    setLanguage(next)
  }

  // 未登录不渲染任何面板：web 端 /settings 由 RequireSession 把门，昵称修改/兑换/退出
  // 都需要会话，未登录时点了也只会失败（对齐 web 的路由守卫语义）
  if (!session) {
    return (
      <View className="page">
        <View className="topbar topbar-title">
          <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack('/pages/me/me')}>
            {copy.back}
          </Button>
          <Text className="brand brand-sm">{copy.settingsTitle}</Text>
        </View>
        <LoginPrompt text={copy.meRequiresLogin} />
      </View>
    )
  }

  return (
    <View className="page">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack('/pages/me/me')}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.settingsTitle}</Text>
      </View>

      {/* 个人资料：昵称可改，实际邮箱和平台标识只读。 */}
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
          <View className="me-edit">
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

        {identities.map(({ label, value }) => (
          <View className="settings-row" key={`${label}:${value}`}>
            <Text className="muted settings-label">{copy[label]}</Text>
            <Button className="settings-value settings-identity" ariaLabel={copy[label]} onClick={() => setSelectedIdentity({ label: copy[label], value })}>
              {value.length > 36 ? `${value.slice(0, 36)}…` : value}
            </Button>
          </View>
        ))}

        {error && <Text className="error-text">{error}</Text>}
        {notice && <Text>{notice}</Text>}
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

      {me.data && <BindEmailSection boundEmail={me.data.boundEmail} />}

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
      {selectedIdentity && (
        <Modal open onClose={() => setSelectedIdentity(null)} title={selectedIdentity.label} closeLabel={copy.gotIt}>
          <Text className="settings-identity-full" userSelect>{selectedIdentity.value}</Text>
        </Modal>
      )}
      <DialogHost />
    </View>
  )
}
