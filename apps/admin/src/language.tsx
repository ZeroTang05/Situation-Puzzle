/** 管理端语言上下文：与 web 端共享同一套语言枚举与持久化 key。 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Language } from '@jev/i18n';

interface LanguageContextValue {
  language: Language;
  setLanguage: (value: Language) => void;
}

const LanguageContext = createContext<LanguageContextValue>({ language: 'zh', setLanguage: () => {} });

function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  const param = new URLSearchParams(window.location.search).get('lang');
  if (param === 'en' || param === 'zh') return param;
  const stored = localStorage.getItem('jev.language');
  return stored === 'en' ? 'en' : 'zh';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  }, [language]);

  const setLanguage = (value: Language) => {
    setLanguageState(value);
    localStorage.setItem('jev.language', value);
  };

  return <LanguageContext.Provider value={{ language, setLanguage }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}