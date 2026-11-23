/** 小程序绑定邮箱，复用服务端验证码契约。 */
import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { bindEmailRequestSchema, verifyBoundEmailRequestSchema } from '@jev/contracts'
import { emailBindingCopy } from '@jev/i18n'
import { api, translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'

export function BindEmailSection({ boundEmail }: { boundEmail: string | null }) {
  const { language, copy } = useLanguage()
  const text = emailBindingCopy[language]
  const queries = useQueryClient()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const address = bindEmailRequestSchema.safeParse({ email: boundEmail ?? email })
  const send = useMutation({
    mutationFn: (value: string) => api('/me/email-binding/send', { method: 'POST', body: { email: value } }),
    onSuccess: (_result, value) => setSentTo(value),
  })
  const verify = useMutation({
    mutationFn: (body: { email: string; code: string }) => api('/me/email-binding/verify', { method: 'POST', body }),
    onSuccess: async () => {
      await Promise.all([queries.invalidateQueries({ queryKey: ['me'] }), queries.invalidateQueries({ queryKey: ['entitlement-preview'] })])
      setOpen(false)
      setCode('')
      setSentTo(null)
    },
  })
  const verification = verifyBoundEmailRequestSchema.safeParse({ email: sentTo, code })
  const busy = send.isPending || verify.isPending
  const error = verify.error ?? send.error

  return (
    <View className="panel stack">
      {!open ? <Button className="btn" onClick={() => { setOpen(true); send.reset(); verify.reset() }}>{boundEmail ? text.verifyAgain : text.bind}</Button> : (
        <View className="stack">
          <Text>{text.email}</Text>
          <Input className="field" type="text" maxlength={254} value={boundEmail ?? email} disabled={busy || Boolean(boundEmail)} onInput={(event) => { setEmail(event.detail.value); setSentTo(null); setCode('') }} />
          <Button className="btn" disabled={!address.success || busy} onClick={() => { verify.reset(); if (address.success) send.mutate(address.data.email) }}>{text.send}</Button>
          {sentTo && <>
            <Text>{text.sent}</Text>
            <Input className="field" type="number" maxlength={6} value={code} onInput={(event) => setCode(event.detail.value)} />
            <Button className="btn btn-primary" disabled={!verification.success || busy} onClick={() => { if (verification.success) verify.mutate(verification.data) }}>{text.confirm}</Button>
          </>}
          {error && <Text className="error-text">{translateApiError(error, language, copy.saveFail)}</Text>}
          <Button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{copy.cancel}</Button>
        </View>
      )}
    </View>
  )
}
