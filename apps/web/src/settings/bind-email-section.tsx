/** TapTap 绑定邮箱：先发验证码，再用同一邮箱确认。 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bindEmailRequestSchema, verifyBoundEmailRequestSchema } from '@jev/contracts';
import { emailBindingCopy } from '@jev/i18n';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';

export function BindEmailSection({ boundEmail }: { boundEmail: string | null }) {
  const { language, copy } = useLanguage();
  const text = emailBindingCopy[language];
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const address = bindEmailRequestSchema.safeParse({ email: boundEmail ?? email });
  const send = useMutation({
    mutationFn: (value: string) => api('/me/email-binding/send', { method: 'POST', body: { email: value } }),
    onSuccess: (_result, value) => setSentTo(value),
  });
  const verify = useMutation({
    mutationFn: (body: { email: string; code: string }) => api('/me/email-binding/verify', { method: 'POST', body }),
    onSuccess: async () => {
      await Promise.all([queries.invalidateQueries({ queryKey: ['me'] }), queries.invalidateQueries({ queryKey: ['entitlement-preview'] })]);
      setOpen(false);
      setCode('');
      setSentTo(null);
    },
  });
  const verification = verifyBoundEmailRequestSchema.safeParse({ email: sentTo, code });
  const busy = verify.isPending || send.isPending;
  const error = verify.error ?? send.error;

  return (
    <section className="panel stack">
      {!open ? <button className="btn" onClick={() => { setOpen(true); send.reset(); verify.reset(); }}>{boundEmail ? text.verifyAgain : text.bind}</button> : (
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          if (verification.success && !busy) verify.mutate(verification.data);
        }}>
          <label className="field-label">
            <span>{text.email}</span>
            <input className="field" type="email" autoComplete="email" maxLength={254} value={boundEmail ?? email} readOnly={Boolean(boundEmail)} disabled={busy} onChange={(event) => { setEmail(event.target.value); setSentTo(null); setCode(''); }} />
          </label>
          <button className="btn" type="button" disabled={!address.success || busy} onClick={() => { verify.reset(); if (address.success) send.mutate(address.data.email); }}>{text.send}</button>
          {sentTo && <>
            <label className="field-label">
              <span>{text.sent}</span>
              <input className="field" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={!verification.success || busy}>{text.confirm}</button>
          </>}
          {error && <p className="error-text" role="alert">{translateApiError(error, language, copy.saveFail)}</p>}
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>{copy.cancel}</button>
        </form>
      )}
    </section>
  );
}
