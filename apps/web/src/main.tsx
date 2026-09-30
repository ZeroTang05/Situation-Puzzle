import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DialogProvider } from '@jev/ui';
import '@jev/ui/dialog.css';
import { LanguageProvider, useLanguage } from './state/language.js';
import { App } from './app.js';
import '@jev/ui/styles.css';
import './styles.css';

/** 弹窗按钮随玩家已保存的界面语言显示。 */
function AppDialogs() {
  const { copy } = useLanguage();
  return <DialogProvider confirmLabel={copy.confirm} cancelLabel={copy.cancel}><BrowserRouter><App /></BrowserRouter></DialogProvider>;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <AppDialogs />
      </LanguageProvider>
    </QueryClientProvider>
  </StrictMode>,
);
