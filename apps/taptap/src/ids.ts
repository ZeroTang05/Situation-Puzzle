/** 沿用微信端的 UUID v4 请求编号格式；身份令牌统一由服务器签发。 */
export function newRequestId(): string {
  const hex = '0123456789abcdef';
  const bytes = (n: number) => Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]!).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)]!;
  return `${bytes(8)}-${bytes(4)}-4${bytes(3)}-${variant}${bytes(3)}-${bytes(12)}`;
}
