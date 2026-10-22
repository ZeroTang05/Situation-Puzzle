/** 语言上下文：?lang=zh|en 贯穿界面；默认中文，选择存 localStorage 并上报服务端。 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { t, type Copy, type Language } from '@jev/i18n';
import { api } from '../api/client.js';
import { useJevSession } from '../api/auth-client.js';

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
  const { session } = useJevSession();

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    // 落到 localStorage：每个请求的 X-Jev-Language 头按它上报当前选择
    localStorage.setItem('jev.language', language);
  }, [language]);

  const setLanguage = (value: Language) => {
    setLanguageState(value);
    localStorage.setItem('jev.language', value);
    // 已登录时把语言写回账号档案：服务端的事务邮件（验证码 / 重置密码）按它发
    if (session) {
      void api('/me/language', { method: 'PATCH', body: { language: value } }).catch(() => undefined);
    }
  };

  return <LanguageContext.Provider value={{ language, setLanguage, copy: t(language) }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
