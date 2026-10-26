/**
 * 「我的」页的赞助面板：商品列表 + 在线支付。
 *
 * 两条在线收款路径并存：
 *  - 微信支付 Native（需商户资质）：扫码购买；
 *  - 支付宝（需商户资质）：扫码或跳转页面购买。
 * 兑换码（零资质通道）的入口在设置页。
 *
 * 权益只来自服务端：支付回调后由服务端发放授权，前端只刷新 /me。
 * 浏览器回跳不发放权益（前端只轮询订单状态）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { format } from '@jev/i18n';
import { QrCode } from './qr-code.js';
import { narrowScanHint } from './sponsor-hint.js';

type PayChannel = 'wechat_native' | 'alipay';

interface Product {
  productVersionId: string;
  type: 'monthly' | 'lifetime';
  title: string;
  priceMinor: number;
  currency: string;
}

interface ChannelsResponse {
  channels: Array<{ channel: PayChannel | 'redeem_code'; available: boolean; label: string }>;
}

interface OrderView {
  orderId: string;
  status: 'pending' | 'paid' | 'closing' | 'closed' | 'refund_pending' | 'refunded';
  channel: PayChannel;
  payUrl: string | null;
  qrContent: string | null;
}

/** 分转成元显示：600 分 = 6 元。 */
function yuan(priceMinor: number) {
  return (priceMinor / 100).toFixed(priceMinor % 100 === 0 ? 0 : 2);
}

/**
 * 窄屏（手机）判定。
 *
 * 微信 Native 是「PC 网页亮码、微信 App 扫码」的形态，手机上打开这个页面
 * 的话，二维码就在自己屏幕上，扫不了——官方也不允许「相册识别 / 长按识别」。
 * 所以窄屏且没有跳转链接时，提示改成「请用电脑扫码」。
 */
function useNarrowViewport() {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 600px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 600px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    setNarrow(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function SponsorPanel() {
  const { copy, language } = useLanguage();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<PayChannel>('wechat_native');
  const [order, setOrder] = useState<OrderView | null>(null);

  const products = useQuery({ queryKey: ['sponsor-products'], queryFn: () => api<Product[]>('/sponsor-products'), retry: false });
  const channels = useQuery({ queryKey: ['payment-channels'], queryFn: () => api<ChannelsResponse>('/payment-channels'), retry: false });

  const payChannels = (channels.data?.channels ?? []).filter(
    (c): c is { channel: PayChannel; available: boolean; label: string } => c.channel !== 'redeem_code',
  );
  const available = payChannels.filter((c) => c.available);
  const current = payChannels.find((c) => c.channel === channel);
  const channelReady = Boolean(current?.available);
  const narrow = useNarrowViewport();

  const buy = useMutation({
    mutationFn: (productVersionId: string) =>
      api<OrderView>('/orders', { method: 'POST', body: { productVersionId, channel } }),
    onSuccess: (result) => {
      setOrder(result);
      // 电脑网站支付（page）只返回跳转链接不返回二维码，直接自动跳转省一次点击。
      // 优先新开标签页以保住本页的订单轮询；被弹窗拦截（移动端异步 window.open
      // 常被拦）时退化为当前页跳转。扫码通道（qrContent 非空）不在此列。
      if (result.payUrl && !result.qrContent) {
        const opened = window.open(result.payUrl, '_blank');
        if (!opened) window.location.href = result.payUrl;
      }
    },
  });

  // 支付状态轮询：权益只由服务端发放，付完刷新 /me 即可
  useEffect(() => {
    if (!order || order.status === 'paid' || order.status === 'closed' || order.status === 'refunded') return;
    const timer = setInterval(async () => {
      try {
        const next = await api<OrderView>(`/orders/${order.orderId}`);
        setOrder(next);
        if (next.status === 'paid') {
          await queryClient.invalidateQueries({ queryKey: ['me'] });
        }
      } catch {
        /* 网络抖动：下轮再试 */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [order, queryClient]);

  return (
    <section className="me-section sponsor-panel">
      <div className="me-section-head">
        <h3 className="me-section-title">{copy.sponsorPanel}</h3>
      </div>
      <p className="muted sponsor-hint">{copy.sponsorPanelHint}</p>

      {payChannels.length > 0 && (
        <div className="sponsor-channels" role="group" aria-label={copy.sponsorPayMethod}>
          <span className="sponsor-channels-label">{copy.sponsorPayMethod}</span>
          {payChannels.map((c) => (
            <button
              key={c.channel}
              type="button"
              className={`sponsor-channel${channel === c.channel ? ' is-active' : ''}${c.available ? '' : ' is-disabled'}`}
              disabled={!c.available}
              onClick={() => {
                setChannel(c.channel);
                setOrder(null);
              }}
            >
              {c.channel === 'wechat_native' ? copy.sponsorChannelWechat : copy.sponsorChannelAlipay}
            </button>
          ))}
        </div>
      )}

      <ul className="sponsor-products">
        {products.data?.map((product) => (
          <li key={product.productVersionId} className="sponsor-product">
            <div className="sponsor-product-main">
              <span className="sponsor-product-title">
                {product.type === 'monthly' ? copy.sponsorProductMonthly : copy.sponsorProductLifetime}
              </span>
              <span className="sponsor-product-price">
                {format(product.type === 'monthly' ? copy.sponsorPriceMonthly : copy.sponsorPriceLifetime, {
                  price: yuan(product.priceMinor),
                })}
              </span>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={!channelReady || buy.isPending}
              onClick={() => buy.mutate(product.productVersionId)}
            >
              {channelReady ? copy.sponsorBuy : copy.sponsorPayChannelUnavailable}
            </button>
          </li>
        ))}
        {products.isPending && <li className="sponsor-product sponsor-product-skeleton" aria-hidden />}
      </ul>

      {buy.isError && (
        <p className="error-text" role="alert">{translateApiError(buy.error, language, copy.sponsorPayChannelUnavailable)}</p>
      )}

      {order && (
        <div className="sponsor-pay">
          {order.status === 'paid' ? (
            <p className="sponsor-pay-status is-ok" role="status">{copy.sponsorPaymentPaid}</p>
          ) : order.status === 'pending' ? (
            <>
              <p className="muted">{copy.sponsorOrderCreated}</p>
              {order.qrContent && <QrCode value={order.qrContent} />}
              <p className="muted sponsor-pay-hint">
                {narrowScanHint(narrow, Boolean(order.payUrl)) ? copy.sponsorQrHintNarrow : copy.sponsorQrHint}
              </p>
              {order.payUrl && (
                <a className="btn btn-primary" href={order.payUrl} target="_blank" rel="noreferrer">
                  {copy.sponsorGoPay}
                </a>
              )}
              <p className="muted sponsor-pay-status" role="status">{copy.sponsorPaymentPending}</p>
            </>
          ) : (
            <p className="sponsor-pay-status is-warn" role="status">{copy.sponsorPaymentFailed}</p>
          )}
        </div>
      )}
    </section>
  );
}
