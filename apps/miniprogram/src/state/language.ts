/**
 * 语言状态：与 web 端同规格（存储键 jev.language、默认中文、请求头实时读取）。
 * 小程序存储换 Taro storage；跨页同步用 Taro.eventCenter 广播，
 * 设置页改语言后，栈里已打开的页面下次 onShow 重取也能拿到新值。
 */
import { useCallback, useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { copy, type Language } from '@jev/i18n'

const LANGUAGE_KEY = 'jev.language'
const LANGUAGE_EVENT = 'jev:language-changed'

function readLanguage(): Language {
  const stored = Taro.getStorageSync<string>(LANGUAGE_KEY)
  return stored === 'en' ? 'en' : 'zh'
}

export function useLanguage(): { language: Language; setLanguage: (next: Language) => void; copy: (typeof copy)[Language] } {
  const [language, setLanguageState] = useState<Language>(readLanguage)

  // 其它页面切换语言时同步本页（eventCenter 解绑用同一个函数引用）
  useEffect(() => {
    const onChange = () => setLanguageState(readLanguage())
    Taro.eventCenter.on(LANGUAGE_EVENT, onChange)
    return () => {
      Taro.eventCenter.off(LANGUAGE_EVENT, onChange)
    }
  }, [])

  const setLanguage = useCallback((next: Language) => {
    Taro.setStorageSync(LANGUAGE_KEY, next)
    setLanguageState(next)
    Taro.eventCenter.trigger(LANGUAGE_EVENT)
  }, [])

  return { language, setLanguage, copy: copy[language] }
}
