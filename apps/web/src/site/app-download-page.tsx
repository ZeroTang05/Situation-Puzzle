/**
 * App 下载页（/app）：官网直链下载 Android 安装包。
 * 安装包由服务器 ./dl 目录经 nginx /dl/ 提供（见 infra/web.nginx.conf 与 docker-compose），
 * 页面只负责入口；桌面端展示二维码供手机扫码。
 */
import { useNavigate } from 'react-router';
import type { Language } from '@jev/i18n';
import { useBack } from '../back.js';
import { BrandHeading } from '../brand-heading.js';
import { isAppShell, siteOrigin } from '../app-runtime.js';
import { QrCode } from '../me/qr-code.js';
import { useLanguage } from '../state/language.js';

/** 下载页专属文案（全局 copy 没有这些条目，就地双语） */
const copy: Record<Language, {
  title: string;
  download: string;
  scanHint: string;
  requirement: string;
  installHint: string;
  installHintTitle: string;
  webHint: string;
  inAppTitle: string;
  inAppHint: string;
  backHome: string;
  privacy: string;
}> = {
  zh: {
    title: '下载 App',
    download: '下载 Android 版',
    scanHint: '手机扫码直接下载',
    requirement: '需要 Android 7.0 或以上',
    installHintTitle: '安装提示',
    installHint: '首次安装会请求「允许安装未知应用」，对当前浏览器允许后继续即可；安装包由本站官方签名。',
    webHint: 'iPhone 或电脑可以直接用网页版，无需下载。',
    inAppTitle: '你已经在 App 里了',
    inAppHint: '这就是完整版，无需再下载。',
    backHome: '回首页',
    privacy: '隐私政策',
  },
  en: {
    title: 'Get the App',
    download: 'Download for Android',
    scanHint: 'Scan with your phone to download',
    requirement: 'Requires Android 7.0 or later',
    installHintTitle: 'Install note',
    installHint: 'On first install, Android asks to allow this browser to install unknown apps. Allow it and continue; the package is officially signed by this site.',
    webHint: 'On iPhone or desktop, just use the web version — no download needed.',
    inAppTitle: 'You are already in the App',
    inAppHint: 'This is the full experience, nothing to download.',
    backHome: 'Back home',
    privacy: 'Privacy Policy',
  },
};

export function AppDownloadPage() {
  const { copy: globalCopy, language } = useLanguage();
  const c = copy[language];
  const back = useBack('/');
  const navigate = useNavigate();
  // App 壳指向生产域名；网页端取当前站点（开发期同源代理也成立）
  const apkUrl = `${siteOrigin()}/dl/jev-turtle-soup.apk`;

  return (
    <main className="shell narrow">
      <header className="topbar topbar-title">
        <button type="button" className="btn btn-ghost btn-sm" onClick={back}>{globalCopy.back}</button>
        <BrandHeading>{globalCopy.brand}</BrandHeading>
      </header>

      <section className="panel stack">
        <h2>{c.title}</h2>
        {isAppShell ? (
          <>
            <p className="muted">{c.inAppTitle}</p>
            <p className="muted">{c.inAppHint}</p>
            <button className="btn btn-primary" onClick={() => navigate('/')}>{c.backHome}</button>
          </>
        ) : (
          <>
            <a className="btn btn-primary btn-lg" href={apkUrl} download>{c.download}</a>
            <p className="muted">{c.requirement}</p>
            <div className="app-download-qr">
              <QrCode value={apkUrl} size={180} />
              <p className="muted">{c.scanHint}</p>
            </div>
            <h3>{c.installHintTitle}</h3>
            <p className="muted">{c.installHint}</p>
            <p className="muted">{c.webHint}</p>
            <p className="site-footer-links">
              <button type="button" className="link-like" onClick={() => navigate('/privacy')}>{c.privacy}</button>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
