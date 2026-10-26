/**
 * 登录/注册页（与 apps/web/src/auth/login-page.tsx 同一状态机）：
 * - 登录：默认密码 tab；可选「邮箱验证码」tab——发码前服务端校验账号已存在。
 * - 注册：固定流程——昵称（可选）→ 邮箱 → 发验证码（注册用途，仅未注册邮箱）→ 验证
 *   （未注册邮箱返回 USER_NOT_FOUND 即视为验证通过）→ 密码 → 提交后自动登录。
 * - Google / LINUX DO 登录不提供：授权跳转需要系统浏览器承接回调，小程序环境做不到。
 * 登录成功后广播会话变更并返回来源页（页面栈空则回首页）。
 */
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Input, Text, View } from '@tarojs/components'
import { authClient } from '../../api/auth-client'
import { translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'
import { notifySessionChanged } from '../../state/session'
import { displayAuthError, format } from '@jev/i18n'
import {
  OtpSendError,
  readOtpDeadline,
  remainingOtpSeconds,
  sendOtpCode,
  writeOtpDeadline,
} from '../../auth/otp-cooldown'

type Mode = 'signin' | 'signup'
type Method = 'password' | 'otp'
type Stage = 'email' | 'code'

/** 登录完成后的去向：有页面栈就返回来源页（来源页 onShow 会重拉会话），否则回首页 */
function finishLogin(): void {
  notifySessionChanged()
  const pages = Taro.getCurrentPages()
  if (pages.length > 1) void Taro.navigateBack()
  else void Taro.reLaunch({ url: '/pages/index/index' })
}

export default function Login() {
  const { copy, language, setLanguage } = useLanguage()

  const [mode, setMode] = useState<Mode>('signin')
  const [method, setMethod] = useState<Method>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  // 登录 OTP / 注册 OTP 共用一个 stage
  const [stage, setStage] = useState<Stage>('email')
  // 注册专用：是否已通过 OTP；提交注册前必须 true
  const [signupOtpVerified, setSignupOtpVerified] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sendUntil, setSendUntil] = useState(() => readOtpDeadline())
  const [now, setNow] = useState(Date.now)
  const sendWait = remainingOtpSeconds(sendUntil, now)
  const sendLabel = sendWait
    ? language === 'en'
      ? format(copy.retryIn, { n: sendWait })
      : format(copy.resendIn, { n: sendWait })
    : language === 'en'
      ? copy.sendCodeAlt
      : stage === 'code'
        ? copy.resendCode
        : copy.sendCode

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const rememberWait = (seconds: number) => {
    if (!seconds) return
    const deadline = Date.now() + seconds * 1000
    writeOtpDeadline(deadline)
    setSendUntil(deadline)
    setNow(Date.now())
  }

  // ---------- 验证码发送 ----------
  const sendCode = async (purpose: 'signin' | 'signup') => {
    if (busy || remainingOtpSeconds(sendUntil, Date.now()) > 0) return
    setBusy(true)
    setError(null)
    try {
      // 共用 sign-in 验证码池；用途由服务端按 x-jev-otp-purpose 分别校验账号存在性
      const seconds = await sendOtpCode(email.trim().toLowerCase(), 'sign-in', { signup: purpose === 'signup' })
      rememberWait(seconds)
      setStage('code')
      setNotice(purpose === 'signin' ? copy.codeSent : copy.codeSentSignup)
    } catch (err) {
      if (err instanceof OtpSendError) rememberWait(err.retryAfterSeconds)
      else rememberWait(60) // 网络中断时发送结果未知，等待期间仍可验证已有验证码
      setError(translateApiError(err, language, copy.sendCodeFail))
    } finally {
      setBusy(false)
    }
  }

  // 登录 OTP：单一提交即可登录
  const verifyOtpForSignIn = async () => {
    setBusy(true)
    setError(null)
    const { error: verifyError } = await authClient.signIn.emailOtp({
      email: email.trim().toLowerCase(),
      otp: code,
    })
    setBusy(false)
    if (verifyError) {
      setError(displayAuthError(verifyError.code, language, copy.otpInvalid))
      return
    }
    finishLogin()
  }

  // 注册只检查 OTP；邮箱未注册时返回稳定 USER_NOT_FOUND，即视为验证通过
  const verifyOtpForSignup = async () => {
    setBusy(true)
    setError(null)
    const { error: verifyError } = await authClient.emailOtp.checkVerificationOtp({
      email: email.trim().toLowerCase(),
      otp: code,
      type: 'sign-in',
    })
    setBusy(false)
    if (verifyError) {
      if (verifyError.code === 'USER_NOT_FOUND') {
        // 这一步只确认 OTP 一致性；最终注册由 sign-up 写库
        setSignupOtpVerified(true)
        setNotice(copy.emailVerified)
        return
      }
      setError(displayAuthError(verifyError.code, language, copy.otpInvalid))
      return
    }
    // 走到了：邮箱其实已注册，提示用户去登录
    setError(copy.emailRegisteredGoSignin)
  }

  // ---------- 密码登录 ----------
  const passwordSignIn = async () => {
    setBusy(true)
    setError(null)
    const { error: pwError } = await authClient.signIn.email({
      email: email.trim().toLowerCase(),
      password,
    })
    setBusy(false)
    if (pwError) {
      setError(displayAuthError(pwError.code, language, copy.signinFail))
      return
    }
    finishLogin()
  }

  // ---------- 注册：必须在 OTP 通过后才能提交 ----------
  const signupWithPassword = async () => {
    if (!signupOtpVerified) {
      setError(copy.signupVerifyEmailFirst)
      return
    }
    setBusy(true)
    setError(null)
    // 昵称留空就直接注册：服务端会给「用户+随机编号」的默认昵称
    // 验证码随请求头带给服务端闸门原子消费校验（body 由 better-auth 客户端严格定型，走头最稳）
    const { error: signErr } = await authClient.signUp.email(
      { email: email.trim().toLowerCase(), password, name: name.trim() },
      { headers: { 'x-jev-signup-otp': code } },
    )
    if (signErr) {
      setBusy(false)
      setError(displayAuthError(signErr.code, language, copy.signupFail))
      return
    }
    // 注册完成 → 自动登录
    const { error: signInErr } = await authClient.signIn.email({
      email: email.trim().toLowerCase(),
      password,
    })
    setBusy(false)
    if (signInErr) {
      setMode('signin')
      setMethod('password')
      setNotice(copy.signupSuccessSignin)
      return
    }
    finishLogin()
  }

  // 模式切换：清空所有 UI 状态
  const switchMode = (target: Mode) => {
    setMode(target)
    setError(null)
    setNotice(null)
    setCode('')
    setPassword('')
    setStage('email')
    setSignupOtpVerified(false)
    setMethod('password')
  }

  const headingTitle = mode === 'signin' ? copy.signin : copy.signup

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

      <View className="panel stack">
        <Text className="h2">{headingTitle}</Text>

        {/* ===== 登录：密码 / 验证码 双 tab ===== */}
        {mode === 'signin' && (
          <View>
            <View className="mode-tabs">
              <Button
                className={'mode-tab' + (method === 'password' ? ' active' : '')}
                onClick={() => {
                  setMethod('password')
                  setError(null)
                  setStage('email')
                }}
              >
                {copy.password}
              </Button>
              <Button
                className={'mode-tab' + (method === 'otp' ? ' active' : '')}
                onClick={() => {
                  setMethod('otp')
                  setError(null)
                  setStage('email')
                }}
              >
                {copy.emailCode}
              </Button>
            </View>

            {method === 'password' && (
              <View className="stack">
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
                <View className="field-label">
                  <Text>{copy.password}</Text>
                  <Input
                    className="field"
                    password
                    value={password}
                    onInput={(e) => setPassword(e.detail.value)}
                  />
                </View>
                <Button
                  className="btn btn-primary"
                  disabled={busy || !email.includes('@') || password.length < 8}
                  onClick={() => void passwordSignIn()}
                >
                  {copy.login}
                </Button>
                <Button className="link-btn" onClick={() => void Taro.navigateTo({ url: '/pages/forgot-password/forgot-password' })}>
                  {copy.forgotPasswordLink}
                </Button>
              </View>
            )}

            {method === 'otp' && (
              <View className="stack">
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
                  className="btn btn-soft"
                  disabled={busy || sendWait > 0 || !email.includes('@')}
                  onClick={() => void sendCode('signin')}
                >
                  {sendLabel}
                </Button>
                {notice && (
                  <Text className="muted notice">{notice}</Text>
                )}
                <View className="field-label">
                  <Text>{copy.emailCode}</Text>
                  <Input
                    className="field"
                    type="number"
                    value={code}
                    onInput={(e) => setCode(e.detail.value)}
                  />
                </View>
                <Button
                  className="btn btn-primary"
                  disabled={busy || code.length < 4}
                  onClick={() => void verifyOtpForSignIn()}
                >
                  {copy.signIn}
                </Button>
              </View>
            )}
          </View>
        )}

        {/* ===== 注册：固定流程 ===== */}
        {mode === 'signup' && (
          <View className="stack">
            <View className="field-label">
              <Text>{copy.nickname}</Text>
              <Input className="field" type="text" value={name} onInput={(e) => setName(e.detail.value)} />
            </View>

            <View className="field-label">
              <Text>{copy.emailField}</Text>
              <Input
                className="field"
                type="text"
                value={email}
                onInput={(e) => {
                  setEmail(e.detail.value)
                  // 修改邮箱后必须重新走 OTP
                  if (signupOtpVerified) setSignupOtpVerified(false)
                }}
                placeholder={copy.emailField}
              />
            </View>

            {!signupOtpVerified && (
              <Button
                className="btn btn-soft"
                disabled={busy || sendWait > 0 || !email.includes('@')}
                onClick={() => void sendCode('signup')}
              >
                {sendLabel}
              </Button>
            )}

            {!signupOtpVerified && (
              <View className="stack">
                <View className="field-label">
                  <Text>{copy.emailCode}</Text>
                  <Input
                    className="field"
                    type="number"
                    value={code}
                    onInput={(e) => setCode(e.detail.value)}
                  />
                </View>
                <Button
                  className="btn btn-soft"
                  disabled={busy || code.length < 4}
                  onClick={() => void verifyOtpForSignup()}
                >
                  {copy.verifyEmail}
                </Button>
              </View>
            )}

            {signupOtpVerified && (
              <View className="stack">
                <Text className="ok-text">{copy.emailVerified}</Text>
                <View className="field-label">
                  <Text>{copy.password}</Text>
                  <Input
                    className="field"
                    password
                    value={password}
                    onInput={(e) => setPassword(e.detail.value)}
                    placeholder={copy.minChars}
                  />
                </View>
                <Button
                  className="btn btn-primary"
                  disabled={busy || password.length < 8}
                  onClick={() => void signupWithPassword()}
                >
                  {copy.signupAndLogin}
                </Button>
              </View>
            )}
          </View>
        )}

        {error && <Text className="error-text">{error}</Text>}
        {notice && method === 'password' && mode === 'signin' && <Text className="muted notice">{notice}</Text>}

        {/* 模式切换：底部入口 */}
        <View className="mode-switch-row">
          <Text className="muted">{mode === 'signin' ? copy.noAccount : copy.haveAccount}</Text>
          <Button className="link-btn" onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? copy.goSignup : copy.goLogin}
          </Button>
        </View>
      </View>
    </View>
  )
}
