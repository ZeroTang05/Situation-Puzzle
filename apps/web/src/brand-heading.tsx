/** 品牌标题：与站点图标共用汤碗和问号标识，文字提供可访问名称。 */
import type { ReactNode } from 'react';

export function BrandHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className="brand brand-identity">
      <img className="brand-mark" src="/icon.svg" width={28} height={28} alt="" aria-hidden="true" />
      <span>{children}</span>
    </h1>
  );
}
