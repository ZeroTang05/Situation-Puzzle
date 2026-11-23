import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DialogProvider } from '@jev/ui';
import '@jev/ui/dialog.css';
import { LanguageProvider, useLanguage } from './state/language.js';
import { App } from './app.js';
import { TapTapInviteListener } from './rooms/taptap-invite.js';
import '@jev/ui/styles.css';
import './styles.css';
import { isTapH5 } from './app-runtime.js';
import { initializeH5Viewport } from './h5-viewport.js';

const Router = isTapH5 ? HashRouter : BrowserRouter;

/** 弹窗按钮随玩家已保存的界面语言显示。 */
function AppDialogs() {
  const { copy } = useLanguage();
  return <DialogProvider confirmLabel={copy.confirm} cancelLabel={copy.cancel}><Router>{isTapH5 && <TapTapInviteListener />}<App /></Router></DialogProvider>;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** 调试工具先于页面启用，首个请求与首次渲染错误均可记录。 */
async function start() {
  // H5 页头避让 TapTap 自带控件，所有页面共用同一套安全区样式。
  if (isTapH5) {
    document.documentElement.classList.add('taptap-h5');
    initializeH5Viewport();
  }
  if (import.meta.env.VITE_TAPTAP_DEBUG === 'true') {
    const { initializeH5Debug } = await import('./h5-debug.js');
    await initializeH5Debug();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          <AppDialogs />
        </LanguageProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void start();
