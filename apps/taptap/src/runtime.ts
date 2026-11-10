/** 宿主生命周期与语言：只注册一组平台事件，页面订阅后在卸载时取消。 */
import { useSyncExternalStore } from 'react';
import type { Language } from '@jev/contracts';
import { newRequestId } from './ids.js';

let language: Language = tap.getStorageSync('jev.language') === 'en' ? 'en' : 'zh';
const languageListeners = new Set<() => void>();
export function getLanguage(): Language { return language; }
export function setLanguage(value: Language): void {
  language = value; tap.setStorageSync('jev.language', value);
  languageListeners.forEach((listener) => listener());
}
export function useLanguage() {
  const current = useSyncExternalStore((listener) => { languageListeners.add(listener); return () => languageListeners.delete(listener); }, getLanguage);
  return { language: current, t: (zh: string, en: string) => current === 'zh' ? zh : en };
}

const showListeners = new Set<(options: TapLaunchOptions) => void>();
const hideListeners = new Set<() => void>();
let foreground = true;
tap.onShow((options) => { foreground = true; showListeners.forEach((listener) => listener(options)); });
tap.onHide(() => { foreground = false; hideListeners.forEach((listener) => listener()); });
export const isForeground = () => foreground;
export function onShow(listener: (options: TapLaunchOptions) => void): () => void { showListeners.add(listener); return () => showListeners.delete(listener); }
export function onHide(listener: () => void): () => void { hideListeners.add(listener); return () => hideListeners.delete(listener); }

/** 本地请求编号只用于幂等去重，不作为账号或权限凭证。 */
export const requestId = async (): Promise<string> => newRequestId();

export function confirm(title: string, content: string): Promise<boolean> {
  return new Promise((resolve, reject) => tap.showModal({ title, content, confirmText: getLanguage() === 'zh' ? '确认' : 'Confirm', cancelText: getLanguage() === 'zh' ? '取消' : 'Cancel',
    success(result) { resolve(result.confirm); }, fail(error) { reject(new Error(error.errMsg)); },
  }));
}
export function copyText(data: string): Promise<void> {
  return new Promise((resolve, reject) => tap.setClipboardData({ data, success() { resolve(); }, fail(error) { reject(new Error(error.errMsg)); } }));
}
