/**
 * 登录引导卡：me / 好友 / 私聊 / 通知四页共用（panel + 文案 + 登录按钮）。
 * 长文案按句末标点拆成独立短句分行渲染——375px 宽度下长句自动换行
 * 会在词中间断开产生「录。」这类孤行，显式分行后换行点可控。
 */
import type { ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useLanguage } from '../state/language'

export function LoginPrompt({ text }: { text: string }): ReactNode {
  const { copy, language } = useLanguage()
  const lines = text
    .split(/[。.]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const period = language === 'zh' ? '。' : '.'
  return (
    <View className="panel stack login-prompt">
      {lines.map((line) => (
        <Text key={line} className="muted">
          {line}
          {period}
        </Text>
      ))}
      <Button className="btn btn-primary" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
        {copy.login}
      </Button>
    </View>
  )
}
