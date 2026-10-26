/**
 * 验证码发送与倒计时（小程序版，口径对齐 apps/web/src/auth/otp-cooldown.ts）。
 * 倒计时保存绝对截止时间（Taro storage），页面重进/后台切回仍按实际时间计算。
 * 发送接口的响应体是 { success, message?, retryAfterSeconds? } 非标准信封，
 * 与 web 一样直接读原始响应。
 */
import Taro from '@tarojs/taro'
import { apiUrl, authorizationHeader, languageHeader } from '../api/client'

export const otpCooldownKey = 'jev.otp-send-until'

export function remainingOtpSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function readOtpDeadline(): number {
  const value = Taro.getStorageSync<string | number>(otpCooldownKey)
  if (value === '' || value === null || value === undefined) return 0
  const deadline = Number(value)
  if (!Number.isFinite(deadline) || deadline < 0) throw new Error('验证码倒计时存储无效')
  return deadline
}

export function writeOtpDeadline(deadline: number): void {
  Taro.setStorageSync(otpCooldownKey, String(deadline))
}

/** 认证库返回普通 JSON；发送接口额外提供等待秒数。 */
export class OtpSendError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number, public readonly code?: string) {
    super(message)
  }
}

export async function sendOtpCode(
  email: string,
  type: 'sign-in' | 'email-verification',
  options: { signup?: boolean } = {},
): Promise<number> {
  const res = await Taro.request({
    url: apiUrl('/auth/email-otp/send-verification-otp'),
    method: 'POST',
    data: { email, type },
    header: {
      'Content-Type': 'application/json',
      // 登录/注册用途由服务端按此头分别校验账号存在性
      ...(options.signup ? { 'x-jev-otp-purpose': 'signup' } : {}),
      ...authorizationHeader(),
      ...languageHeader(),
    },
    timeout: 30_000,
  })

  const body = (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as {
    success?: boolean
    message?: string
    code?: string
    retryAfterSeconds?: number
  }
  const retry = body.retryAfterSeconds
  if (retry !== undefined && (!Number.isInteger(retry) || retry < 0)) throw new Error('验证码接口返回了无效等待时间')
  if (res.statusCode === 429 && (!retry || retry <= 0)) throw new Error('验证码限流响应缺少等待时间')
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new OtpSendError(body.message ?? '验证码发送失败，请稍后重试。', retry ?? 0, body.code)
  }
  if (!body.success || retry === undefined) throw new Error('验证码发送响应格式不正确')
  return retry
}
