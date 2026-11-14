import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DialogProvider } from '@jev/ui';
import '@jev/ui/dialog.css';
import { LanguageProvider, useLanguage } from './state/language.js';
import { App } from './app.js';
import '@jev/ui/styles.css';
import './styles.css';
import { isTapH5 } from './app-runtime.js';

const Router = isTapH5 ? HashRouter : BrowserRouter;

/** 弹窗按钮随玩家已保存的界面语言显示。 */
function AppDialogs() {
  const { copy } = useLanguage();
  return <DialogProvider confirmLabel={copy.confirm} cancelLabel={copy.cancel}><Router><App /></Router></DialogProvider>;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** 调试工具先于页面启用，首个请求与首次渲染错误均可记录。 */
async function start() {
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
