import type { Viewport } from 'next';
import './globals.css';

// 安卓上键盘弹出时压缩布局视口，页面随之变矮；iOS 走 page.tsx 里的 visualViewport 逻辑
export const viewport: Viewport = { interactiveWidget: 'resizes-content' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
