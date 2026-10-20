/**
 * 支付宝证书序列号计算 CLI（证书模式用）。
 *
 * 支付宝开放平台「证书模式」需要三个证书序列号（SN）：
 *   - 支付宝公钥证书（alipay_cert_sn）
 *   - 应用公钥证书（app_cert_sn）
 *   - 支付宝根证书（alipay_root_cert_sn）
 *
 * SN 的算法：把证书文件（PEM）解出 DER，再取 MD5 十六进制大写。
 * 开放平台控制台也会直接显示这三个 SN，填哪个都行。
 *
 * 用法：
 *   node apps/api/src/cli/pay-cert-sn.mjs <证书文件.pem> [更多证书文件.pem ...]
 *
 * 注意：要用 tsx 跑（依赖 apps/api 的 tsconfig 路径解析）：
 *   pnpm --dir apps/api exec tsx src/cli/pay-cert-sn.ts alipayCertPublicKey.crt appCertPublicKey.crt alipayRootCert.crt
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

function certSn(pem: string): string {
  const cert = new X509Certificate(pem);
  // X509Certificate.raw 是证书的 DER 编码
  return createHash('md5').update(cert.raw).digest('hex').toUpperCase();
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('用法：pay-cert-sn <证书文件.pem> [更多证书文件.pem ...]');
  console.error('  一次可传三个：支付宝公钥证书、应用公钥证书、支付宝根证书');
  process.exit(1);
}

for (const file of files) {
  try {
    const pem = readFileSync(file, 'utf8');
    const sn = certSn(pem);
    const cert = new X509Certificate(pem);
    console.log(`${file}\n  SN   = ${sn}\n  主体 = ${cert.subject}\n  有效期 = ${cert.validFrom} ~ ${cert.validTo}\n`);
  } catch (error) {
    console.error(`${file} 读取失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
