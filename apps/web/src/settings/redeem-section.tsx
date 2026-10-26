/**
 * 兑换码表单：输入运营方发的码，服务端核销并发放会员权益。
 * 原「我的」页赞助面板的一块，按站内信息架构调整迁到设置页；
 * 复用赞助面板的 sponsor-redeem 样式，外观保持一致。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';

interface RedeemResponse {
  orderId: string;
  status: string;
}

export function RedeemSection() {
  const { copy, language } = useLanguage();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeDone, setCodeDone] = useState(false);

  const redeem = useMutation({
    mutationFn: (value: string) => api<RedeemResponse>('/orders/redeem', { method: 'POST', body: { code: value } }),
    onSuccess: async () => {
      setCodeDone(true);
      setCodeError(null);
      setCode('');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (error) => {
      setCodeDone(false);
      setCodeError(translateApiError(error, language, copy.sponsorRedeemUnavailable));
    },
  });

  const submitCode = () => {
    const value = code.trim();
    if (value.length < 6) {
      setCodeError(copy.redeemCodeFailed);
      return;
    }
    redeem.mutate(value);
  };

  return (
    <div className="sponsor-redeem">
      <div className="sponsor-redeem-row">
        <input
          className="sponsor-redeem-input"
          value={code}
          onChange={(event) => { setCode(event.target.value); setCodeDone(false); }}
          placeholder={copy.redeemCodePlaceholder}
          aria-label={copy.redeemCodeTitle}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn btn-primary btn-sm" disabled={redeem.isPending} onClick={submitCode}>
          {copy.redeemCodeSubmit}
        </button>
      </div>
      {codeError && <p className="error-text" role="alert">{codeError}</p>}
      {codeDone && <p className="sponsor-redeem-ok" role="status">{copy.redeemCodeSuccess}</p>}
    </div>
  );
}
