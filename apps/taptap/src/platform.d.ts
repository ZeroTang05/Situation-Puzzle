/** TapTap 官方宿主接口的使用范围。DOM lib 仅提供 Canvas 类型，运行时不访问 window/document。 */
declare const __API_BASE__: string;
declare const __MINI_APP_ID__: string;
declare const __SHARE_TEMPLATE_ID__: string;
declare const __INTERSTITIAL_AD_UNIT_ID__: string;
declare const __REWARDED_AD_UNIT_ID__: string;

interface TapError {
  errMsg: string;
  errno?: number;
}

interface TapTouch {
  clientX: number;
  clientY: number;
}

interface TapLaunchOptions { query?: Record<string, string>; }
interface TapSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (event: { data: string | ArrayBuffer }) => void): void;
  onClose(listener: (event: { code: number; reason?: string }) => void): void;
  onError(listener: (error: TapError) => void): void;
  send(options: { data: string; fail?(error: TapError): void }): void;
  close(options: { code?: number; reason?: string }): void;
}
interface TapInterstitialAd {
  load(): Promise<void>;
  show(): Promise<void>;
  destroy(): void;
  onError(listener: (error: { errCode: number; errMsg: string }) => void): void;
  onClose(listener: () => void): void;
}
interface TapRewardedVideoAd {
  load(): Promise<void>;
  show(): Promise<void>;
  destroy(): void;
  onError(listener: (error: { errCode: number; errMsg: string }) => void): void;
  onClose(listener: (result: { isEnded?: boolean }) => void): void;
}
declare const tap: {
  createCanvas(): HTMLCanvasElement;
  createImage(): HTMLImageElement;
  getWindowInfo(): {
    windowWidth: number;
    windowHeight: number;
    screenHeight: number;
    screenTop: number;
    pixelRatio: number;
    safeArea?: { top: number; bottom: number };
  };
  getMenuButtonBoundingClientRect(): { bottom: number };
  onWindowResize(listener: () => void): void;
  onTouchStart(listener: (event: { touches: TapTouch[] }) => void): void;
  onTouchMove(listener: (event: { touches: TapTouch[] }) => void): void;
  onTouchEnd(listener: (event: { changedTouches: TapTouch[] }) => void): void;
  onTouchCancel(listener: () => void): void;
  onHide(listener: () => void): void;
  onShow(listener: (options: TapLaunchOptions) => void): void;
  getLaunchOptionsSync(): TapLaunchOptions;
  connectSocket(options: { url: string; timeout?: number }): TapSocket;
  onNetworkStatusChange(listener: (event: { isConnected: boolean }) => void): void;
  offNetworkStatusChange(listener: (event: { isConnected: boolean }) => void): void;
  getStorageInfoSync(): { keys: string[] };
  removeStorageSync(key: string): void;
  setClipboardData(options: { data: string; success(): void; fail(error: TapError): void }): void;
  showShareboard(options: { templateId: string; sceneParam: string; success?(): void; fail?(error: TapError): void }): void;
  createInterstitialAd(options: { adUnitId: string }): TapInterstitialAd;
  createRewardedVideoAd(options: { adUnitId: string }): TapRewardedVideoAd;
  onKeyboardInput(listener: (event: { value: string }) => void): void;
  onKeyboardConfirm(listener: (event: { value: string }) => void): void;
  onKeyboardComplete(listener: (event: { value: string }) => void): void;
  onKeyboardHeightChange(listener: (event: { height: number }) => void): void;
  showKeyboard(options: {
    defaultValue: string;
    maxLength: number;
    multiple: boolean;
    confirmHold: boolean;
    confirmType: 'send';
    fail(error: TapError): void;
  }): void;
  hideKeyboard(): void;
  login(options: { timeout: number; success(result: { code: string }): void; fail(error: TapError): void }): void;
  request(options: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    data?: unknown;
    header: Record<string, string>;
    timeout: number;
    success(result: { statusCode: number; data: unknown; header: Record<string, unknown> }): void;
    fail(error: TapError): void;
  }): { abort(): void };
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  showModal(options: {
    title: string;
    content: string;
    showCancel?: boolean;
    confirmText?: string;
    cancelText?: string;
    success?(result: { confirm: boolean }): void;
    fail?(error: TapError): void;
  }): void;
};
