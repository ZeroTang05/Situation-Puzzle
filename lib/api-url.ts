/** 将公开 API 配置固定为完整的站点地址，避免浏览器把域名当作当前网页的相对路径。 */
export function apiBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const configured = value.trim();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL 必须是完整地址，例如 https://situation-puzzle-api.xiaobaozi.cn');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('NEXT_PUBLIC_API_URL 只能填写 http(s) 站点地址，不能带路径、参数或账号密码');
  }
  return url.origin;
}
