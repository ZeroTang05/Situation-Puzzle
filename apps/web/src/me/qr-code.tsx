/**
 * 支付二维码：把通道给的付款内容（微信 code_url / 支付宝 qr_code）渲染成二维码。
 *
 * 用 qrcode-generator 生成 SVG，再转成 data URL 交给 <img> 渲染——
 * 不走 dangerouslySetInnerHTML，SVG 里的脚本也不会被执行。
 */
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const src = useMemo(() => {
    // 0 = 自动选纠错等级；'M' = 15% 容错，付款链接足够
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  }, [value]);

  if (!value) return null;
  return <img className="sponsor-qr" src={src} width={size} height={size} alt="支付二维码" />;
}
