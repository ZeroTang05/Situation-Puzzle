/**
 * 语言上下文：?lang=zh|en 贯穿界面；默认中文，选择只存本地。
 * 语言不落库：每个请求带 X-Jev-Language 头，服务端据此分流（事务邮件等）。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { t, type Copy, type Language } from '@jev/i18n';

interface LanguageContextValue {
  language: Language;
  setLanguage: (value: Language) => void;
  copy: Copy;
}

const LanguageContext = createContext<LanguageContextValue>({ language: 'zh', setLanguage: () => {}, copy: t('zh') });

function initialLanguage(): Language {
  const param = new URLSearchParams(window.location.search).get('lang');
  if (param === 'en' || param === 'zh') return param;
  const stored = localStorage.getItem('jev.language');
  return stored === 'en' ? 'en' : 'zh';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    // 只存本地：请求头 X-Jev-Language 按它上报当前选择，服务端据此分流
    localStorage.setItem('jev.language', language);
  }, [language]);

  const setLanguage = (value: Language) => {
    setLanguageState(value);
    localStorage.setItem('jev.language', value);
  };

  return <LanguageContext.Provider value={{ language, setLanguage, copy: t(language) }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
