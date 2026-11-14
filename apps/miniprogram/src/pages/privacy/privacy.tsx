/**
 * 隐私政策页（代码级对齐 apps/web/src/site/privacy-page.tsx）：
 * 中英双语，纯静态说明，不需要登录。privacy-body 分节排版与 web 同款；
 * 「本地存储」一节按小程序环境补充说明（登录令牌保存在小程序本地存储）。
 */
import type { ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Image, Text, View } from '@tarojs/components'
import { useLanguage } from '../../state/language'
import { goBack } from '../../ui/back'
import iconPng from '../../assets/icon.png'

const zh = {
  title: '隐私政策',
  updated: '更新日期：2026 年 11 月 9 日',
  sections: [
    {
      heading: '我们收集哪些信息',
      items: [
        '账号信息：注册邮箱。用于登录、发送验证码、找回密码，以及好友之间按邮箱精确搜索。',
        '多人互动数据：你参与的房间、提问与回答记录、好友关系与私聊消息、站内通知。多人模式的服务端保存与实时同步依赖这些数据。',
        '支付订单：订单号、金额、支付通道流水号。用于对账、发放赞助权益与售后处理；我们不接触也不存储你的银行卡信息。',
        '服务日志：访问时间、IP 地址、错误信息。用于排查故障与保障服务安全。',
      ],
    },
    {
      heading: '单人模式',
      items: [
        '单人对话记录保存在你的设备本地。判题时，题目、你的问题或还原内容及必要的最近问答会发送给服务器和 AI 判题服务处理，单人对话不写入服务端业务数据库。清除对应的本地数据可删除记录。',
      ],
    },
    {
      heading: '第三方服务',
      items: [
        '支付通道：微信支付 / 支付宝 / 赞助码。付款流程由通道处理，我们只接收其返回的支付结果。',
        'AI 判题服务：单人和多人模式下，判题所需的题目、问题、还原内容与必要的最近问答会发送给 AI 服务生成判定。',
        '邮件服务：通过第三方邮件服务发送验证码与事务邮件。',
      ],
    },
    {
      heading: '本地存储',
      items: [
        '网页版使用会话 Cookie 保持登录状态；App 与小程序版在本地保存登录令牌。界面语言偏好保存在设备本地。这些数据不用于跨站跟踪。',
      ],
    },
    {
      heading: '注销账号',
      items: [
        '发邮件到 support@xiaobaozi.cn 申请注销，我们会删除你的账号与关联的互动数据。与法律责任相关的记录按法律要求保留。',
      ],
    },
    {
      heading: '联系我们',
      items: ['玩家交流 QQ 群：126328391', '对隐私有任何疑问：support@xiaobaozi.cn'],
    },
  ],
}

const en = {
  title: 'Privacy Policy',
  updated: 'Last updated: November 9, 2026',
  sections: [
    {
      heading: 'Information we collect',
      items: [
        'Account: your registration email. Used for sign-in, verification codes, password recovery, and exact-match friend search by email.',
        'Multiplayer data: rooms you join, questions and answers, friendships, direct messages, and notifications. Server-side storage and real-time sync of multiplayer mode rely on them.',
        'Payments: order id, amount, and channel transaction id — used for reconciliation, sponsor benefits, and support. We never see or store your card details.',
        'Service logs: access time, IP address, and error details — used for troubleshooting and service security.',
      ],
    },
    {
      heading: 'Solo mode',
      items: [
        'Solo conversation records are stored on your device. Judging sends the puzzle, your question or solution, and relevant recent Q&A to our server and AI service for processing. Solo conversations are not written to server-side business tables. Clearing the corresponding local data deletes your records.',
      ],
    },
    {
      heading: 'Third-party services',
      items: [
        'Payments: WeChat Pay / Alipay / redeem codes. The payment flow runs on the channel; we only receive the payment result.',
        'AI judging: in solo and multiplayer modes, the puzzle, question or solution, and relevant recent Q&A are sent to an AI service to produce verdicts.',
        'Email: a third-party email service delivers verification codes and transactional mail.',
      ],
    },
    {
      heading: 'Local storage',
      items: [
        'The web version uses a session cookie to keep you signed in; the app and the mini program store a login token locally. Your language preference also lives on your device. None of this is used for cross-site tracking.',
      ],
    },
    {
      heading: 'Account deletion',
      items: [
        'Email support@xiaobaozi.cn to request deletion. We will delete your account and associated game data, keeping only what the law requires.',
      ],
    },
    {
      heading: 'Contact',
      items: ['Player community (QQ group): 126328391', 'Questions about privacy: support@xiaobaozi.cn'],
    },
  ],
}

export default function Privacy(): ReactNode {
  const { copy, language } = useLanguage()
  const c = language === 'zh' ? zh : en

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
      </View>

      <View className="panel stack privacy-body">
        <Text className="h2">{c.title}</Text>
        <Text className="muted">{c.updated}</Text>
        {c.sections.map((section) => (
          <View key={section.heading}>
            <Text className="h3">{section.heading}</Text>
            {section.items.map((item) => (
              <Text key={item} className="privacy-item">
                {item}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  )
}
