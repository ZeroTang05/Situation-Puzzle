/**
 * 「我的」页的赞助面板：商品列表 + 兑换码。
 *
 * 两条收款路径并存：
 *  - 微信支付 Native（需商户资质）：available 时展示扫码购买；
 *  - 兑换码（零资质）：始终可用，运营方用个人收款码收款后发码。
 *
 * 权益只来自服务端：兑换成功后由服务端发放授权，前端只刷新 /me。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { format } from '@jev/i18n';

interface Product {
  productVersionId: string;
  type: 'monthly' | 'lifetime';
  title: string;
  priceMinor: number;
  currency: string;
}

interface ChannelsResponse {
  channels: Array<{ channel: 'wechat_native' | 'redeem_code'; available: boolean; label: string }>;
}

interface RedeemResponse {
  orderId: string;
  status: string;
  title: string;
  amountMinor: number;
  currency: string;
}

/** 分转成元显示：600 分 = 6 元。 */
function yuan(priceMinor: number) {
  return (priceMinor / 100).toFixed(priceMinor % 100 === 0 ? 0 : 2);
}

export function SponsorPanel() {
  const { copy, language } = useLanguage();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeDone, setCodeDone] = useState(false);
  const [payUrl, setPayUrl] = useState<string | null>(null);

  const products = useQuery({ queryKey: ['sponsor-products'], queryFn: () => api<Product[]>('/sponsor-products'), retry: false });
  const channels = useQuery({ queryKey: ['payment-channels'], queryFn: () => api<ChannelsResponse>('/payment-channels'), retry: false });

  const wechatReady = channels.data?.channels.find((c) => c.channel === 'wechat_native')?.available ?? false;

  const buy = useMutation({
    mutationFn: (productVersionId: string) => api<{ orderId: string; status: string; payUrl: string | null }>('/orders', {
      method: 'POST',
      body: { productVersionId },
    }),
    onSuccess: (result) => {
      setPayUrl(result.payUrl);
      setCodeError(null);
    },
  });

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
    <section className="me-section sponsor-panel">
      <div className="me-section-head">
        <h3 className="me-section-title">{copy.sponsorPanel}</h3>
      </div>
      <p className="muted sponsor-hint">{copy.sponsorPanelHint}</p>

      <ul className="sponsor-products">
        {products.data?.map((product) => (
          <li key={product.productVersionId} className="sponsor-product">
            <div className="sponsor-product-main">
              <span className="sponsor-product-title">
                {product.type === 'monthly' ? copy.monthly : copy.lifetime}
              </span>
              <span className="sponsor-product-price">
                {format(product.type === 'monthly' ? copy.sponsorPriceMonthly : copy.sponsorPriceLifetime, {
                  price: yuan(product.priceMinor),
                })}
              </span>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={!wechatReady || buy.isPending}
              onClick={() => buy.mutate(product.productVersionId)}
            >
              {wechatReady ? copy.sponsorBuy : copy.sponsorPayChannelUnavailable}
            </button>
          </li>
        ))}
        {products.isPending && <li className="sponsor-product sponsor-product-skeleton" aria-hidden />}
      </ul>

      {buy.isError && (
        <p className="error-text" role="alert">{translateApiError(buy.error, language, copy.sponsorPayChannelUnavailable)}</p>
      )}
      {payUrl && (
        <div className="sponsor-pay">
          <p className="muted">{copy.sponsorScanToPay}</p>
          {/* 微信 Native 的 code_url 是 weixin:// 链接：手机端直接唤起微信收银台；
              桌面端可把它贴到任意二维码生成器（不内联第三方服务，避免把支付链接外发）。 */}
          <a className="btn btn-primary" href={payUrl}>{copy.sponsorScanToPay}</a>
          <p className="muted sponsor-pay-hint">{payUrl}</p>
        </div>
      )}

      <div className="sponsor-redeem">
        <h4 className="sponsor-redeem-title">{copy.redeemCodeTitle}</h4>
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
    </section>
  );
}
