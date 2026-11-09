/**
 * 成员列表（对齐 apps/web/src/rooms/room-page.tsx 的 MemberList）：
 * 在线点、昵称、房主/主持人徽标；房主的踢人、主持审批/撤销；
 * 本人申请成为主持人 / 退出主持人。会客厅页与房间页共用。
 */
import type { ReactNode } from 'react'
import { Button, Text, View } from '@tarojs/components'
import { useLanguage } from '../../state/language'

export function MemberList({
  state,
  me,
  isHost,
  onKick,
  onRequestHost,
  onApproveHost,
  onRejectHost,
  onRevokeHost,
  onResignHost,
}: {
  state: {
    members: Array<{ userId: string; nickname: string; online: boolean; isHost: boolean; isUserHost?: boolean }>
    hostRequests?: Array<{ userId: string; nickname: string }>
  }
  me: string | null
  isHost: boolean
  onKick: (userId: string) => void
  onRequestHost?: () => void
  onApproveHost?: (userId: string) => void
  onRejectHost?: (userId: string) => void
  onRevokeHost?: (userId: string) => void
  onResignHost?: () => void
}): ReactNode {
  const { copy } = useLanguage()
  const pending = new Set((state.hostRequests ?? []).map((r) => r.userId))
  return (
    <View className="member-list">
      {state.members.map((m) => (
        <View key={m.userId} className="member-row">
          <View className={`presence-dot${m.online ? ' online' : ''}`} />
          <Text className={`member-name${m.userId === me ? ' member-name-self' : ''}`}>{m.nickname}</Text>
          {m.isHost && <Text className="verdict-badge verdict-solved">{copy.host}</Text>}
          {m.isUserHost && <Text className="verdict-badge verdict-uncertain">{copy.userHost}</Text>}
          {isHost && !m.isHost && (
            <View className="member-actions">
              <Button className="btn btn-sm btn-danger" onClick={() => onKick(m.userId)}>
                {copy.kick}
              </Button>
            </View>
          )}
          {/* 房主审核：待审成员行内直接批准或拒绝 */}
          {isHost && pending.has(m.userId) && onApproveHost && onRejectHost && (
            <View className="member-actions">
              <Button className="btn btn-sm" onClick={() => onApproveHost(m.userId)}>
                {copy.hostApprove}
              </Button>
              <Button className="btn btn-sm btn-ghost" onClick={() => onRejectHost(m.userId)}>
                {copy.hostReject}
              </Button>
            </View>
          )}
          {/* 房主可撤销他人已有的主持身份：降级为普通玩家 */}
          {isHost && m.isUserHost && m.userId !== me && onRevokeHost && (
            <View className="member-actions">
              <Button className="btn btn-sm btn-ghost" onClick={() => onRevokeHost(m.userId)}>
                {copy.hostRevoke}
              </Button>
            </View>
          )}
          {/* 本人入口：申请成为主持人 / 退出主持人（房主自申请服务端直接通过） */}
          {m.userId === me && !m.isUserHost && onRequestHost && (
            <View className="member-actions">
              <Button className="btn btn-sm" disabled={pending.has(m.userId)} onClick={onRequestHost}>
                {pending.has(m.userId) ? copy.hostApplyPending : copy.hostApply}
              </Button>
            </View>
          )}
          {m.userId === me && m.isUserHost && onResignHost && (
            <View className="member-actions">
              <Button className="btn btn-sm" onClick={onResignHost}>
                {copy.hostResign}
              </Button>
            </View>
          )}
        </View>
      ))}
    </View>
  )
}
