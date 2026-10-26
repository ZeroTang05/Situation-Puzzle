/**
 * 隐私政策页：中英双语，纯静态说明，不需要登录。
 * 内容与 apps/web/src/site/privacy-page.tsx 同源；「本地存储」一节按小程序
 * 环境补充说明（登录令牌保存在小程序本地存储）。
 */
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useLanguage } from '../../state/language'

const zh = {
  title: '隐私政策',
  updated: '更新日期：2026 年 10 月 24 日',
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
        '单人模式无需登录，整局对话只保存在你的设备本地，不会上传到服务器。清除本地数据即彻底删除。',
      ],
    },
    {
      heading: '第三方服务',
      items: [
        '支付通道：微信支付 / 支付宝 / 赞助码。付款流程由通道处理，我们只接收其返回的支付结果。',
        'AI 判题服务：多人模式下，题目与问答内容会发送给 AI 服务生成判定。',
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
  updated: 'Last updated: October 24, 2026',
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
        'Solo mode needs no sign-in. The whole conversation stays on your device and is never uploaded. Clearing local data deletes it for good.',
      ],
    },
    {
      heading: 'Third-party services',
      items: [
        'Payments: WeChat Pay / Alipay / redeem codes. The payment flow runs on the channel; we only receive the payment result.',
        'AI judging: in multiplayer, the puzzle and Q&A are sent to an AI service to produce verdicts.',
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

export default function Privacy() {
  const { copy, language } = useLanguage()
  const c = language === 'zh' ? zh : en

  return (
    <View className="page">
      <View className="topbar">
        <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.brand}</Text>
      </View>

      <View className="panel stack">
        <Text className="h2">{c.title}</Text>
        <Text className="muted">{c.updated}</Text>
        {c.sections.map((section) => (
          <View key={section.heading} className="stack-sm">
            <Text className="h3">{section.heading}</Text>
            {section.items.map((item) => (
              <Text key={item} className="privacy-item">
                · {item}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  )
}
