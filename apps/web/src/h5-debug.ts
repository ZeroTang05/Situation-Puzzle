/** H5 开发诊断：仅记录请求元数据和错误位置，日志中不保存请求正文、响应正文或认证头。 */
import VConsole from 'vconsole';
import { apiBase } from './app-runtime.js';

interface DebugEntry {
  time: string;
  kind: string;
  [key: string]: unknown;
}

/** 在页面启动前安装调试面板，手机和 Chrome 检查器读取同一份记录。 */
export async function initializeH5Debug(): Promise<void> {
  const records: DebugEntry[] = [];
  const panel = document.createElement('div');
  const output = document.createElement('pre');
  output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;font-size:12px';
  const exportButton = document.createElement('button');
  exportButton.textContent = '导出诊断日志';
  panel.append(exportButton, output);

  const record = (kind: string, fields: Record<string, unknown> = {}) => {
    records.push({ time: new Date().toISOString(), kind, ...fields });
    if (records.length > 200) records.shift();
    output.textContent = records.map((entry) => JSON.stringify(entry)).join('\n');
  };
  Object.assign(window, { __JEV_DEBUG__: { records: () => records.map((entry) => ({ ...entry })) } });
  exportButton.onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'jev-h5-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // 默认 Network / Storage / Log 面板会记录原始凭据或玩家文字，只启用脱敏诊断面板。
  const consolePanel = new VConsole({ defaultPlugins: [], theme: 'dark', pluginOrder: ['jev'] });
  consolePanel.removePlugin('default');
  const plugin = new VConsole.VConsolePlugin('jev', '运行与网络');
  plugin.on('renderTab', (callback: (element: HTMLElement) => void) => callback(panel));
  consolePanel.addPlugin(plugin);
  // 调试开关放在屏幕侧边中部，底部的输入、发送与汤底按钮保持可点击。
  const placeSwitch = () => consolePanel.setSwitchPosition(8, Math.round(innerHeight / 2));
  placeSwitch();
  window.addEventListener('resize', placeSwitch);

  const fetchOriginal = window.fetch.bind(window);
  const apiOrigin = apiBase || location.origin;
  window.fetch = async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (address.origin !== apiOrigin || !address.pathname.startsWith('/api/v1/')) return fetchOriginal(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const url = address.origin + address.pathname;
    const startedAt = performance.now();
    try {
      const response = await fetchOriginal(input, init);
      const metadata: Record<string, unknown> = { method, url, status: response.status, elapsedMs: Math.round(performance.now() - startedAt) };
      if (response.headers.get('content-type')?.includes('application/json')) {
        try {
          const body = await response.clone().json() as { requestId?: unknown; error?: { code?: unknown } } | null;
          if (typeof body?.requestId === 'string') metadata.requestId = body.requestId;
          if (typeof body?.error?.code === 'string') metadata.errorCode = body.error.code;
        } catch {
          metadata.errorCode = 'INVALID_JSON';
        }
      } else {
        metadata.errorCode = 'NON_JSON_RESPONSE';
      }
      record('response', metadata);
      return response;
    } catch (error) {
      record('network-error', { method, url, elapsedMs: Math.round(performance.now() - startedAt), errorName: error instanceof Error ? error.name : typeof error });
      throw error;
    }
  };

  const runtimeError = (error: unknown) => {
    record('runtime-error', {
      errorName: error instanceof Error ? error.name : typeof error,
      frames: error instanceof Error ? error.stack?.split('\n').slice(1, 9).map((line) => line.replace(/\?[^)\s]*/g, '')) : [],
    });
  };
  window.addEventListener('error', (event) => runtimeError(event.error));
  window.addEventListener('unhandledrejection', (event) => runtimeError(event.reason));
  window.addEventListener('online', () => record('online'));
  window.addEventListener('offline', () => record('offline'));
  record('environment', { origin: location.origin, entry: location.pathname, apiBase, online: navigator.onLine, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent });
}
