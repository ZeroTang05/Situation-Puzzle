import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jev 海龟汤',
  description: '让 Jev 当主持人的海龟汤小游戏',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
