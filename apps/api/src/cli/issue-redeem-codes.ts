/**
 * 赞助码批量发放 CLI（运营用）。
 *
 * 场景：微信/支付宝商户资质未开通，运营方用个人收款码收款后，需要一批可交付的兑换码。
 * 这个脚本直接连生产库发码，不依赖后台会话，适合「收款到账 → 立刻出码」的动作。
 *
 * 用法（在服务器上，进 api 容器执行）：
 *   docker exec situation-puzzle-api-1 pnpm --dir apps/api exec tsx src/cli/issue-redeem-codes.ts \
 *     --type monthly --count 10 --note "10月推广"
 *   docker exec situation-puzzle-api-1 pnpm --dir apps/api exec tsx src/cli/issue-redeem-codes.ts \
 *     --type lifetime --count 5 --expires 2026-12-31T23:59:59Z
 *
 * 码只在本次输出里出现一次；之后用后台接口按批次查状态。
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { createDb, productVersions, redeemCodes, sponsorProducts } from '@jev/database';
import { generateRedeemCode, normalizeRedeemCode } from '@jev/domain';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const type = arg('type');
  if (type !== 'monthly' && type !== 'lifetime') {
    console.error('用法：--type monthly|lifetime --count N [--note 文本] [--expires ISO时间]');
    process.exit(1);
  }
  const count = Number.parseInt(arg('count') ?? '1', 10);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    console.error('--count 必须是 1～500 的整数');
    process.exit(1);
  }
  const note = arg('note');
  const expiresRaw = arg('expires');
  const expiresAt = expiresRaw ? new Date(expiresRaw) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    console.error('--expires 不是合法时间');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }

  const db = createDb(databaseUrl);
  try {
    // 商品版本：没有就按首发口径建（月度 600 分 / 永久 2000 分）。
    // listProducts() 也会兜底建商品，但那是接口路径；这里让 CLI 自给自足，一条命令就能出码。
    let [product] = await db.db
      .select({
        id: productVersions.id,
        title: productVersions.title,
        priceMinor: productVersions.priceMinor,
        currency: productVersions.currency,
      })
      .from(productVersions)
      .innerJoin(sponsorProducts, eq(sponsorProducts.id, productVersions.productId))
      .where(
        and(
          eq(sponsorProducts.type, type),
          eq(productVersions.available, true),
          eq(sponsorProducts.available, true),
        ),
      )
      .orderBy(desc(productVersions.versionNo))
      .limit(1);

    if (!product) {
      const [row] = await db.db.insert(sponsorProducts).values({ type }).returning();
      const [version] = await db.db
        .insert(productVersions)
        .values({
          productId: row!.id,
          versionNo: 1,
          priceMinor: type === 'monthly' ? 600 : 2000,
          title: type === 'monthly' ? '月度会员' : '永久会员',
        })
        .returning({ id: productVersions.id, title: productVersions.title, priceMinor: productVersions.priceMinor, currency: productVersions.currency });
      product = version!;
      console.log(`已按首发口径创建商品：${product.title}（${(product.priceMinor / 100).toFixed(2)} ${product.currency}）`);
    }

    const batchId = `B${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const rows = Array.from({ length: count }, () => {
      const code = generateRedeemCode();
      return {
        code,
        codeKey: normalizeRedeemCode(code),
        productVersionId: product.id,
        status: 'unused' as const,
        batchId,
        note: note ?? null,
        expiresAt: expiresAt ?? null,
      };
    });
    const inserted = await db.db
      .insert(redeemCodes)
      .values(rows)
      .onConflictDoNothing({ target: redeemCodes.codeKey })
      .returning({ code: redeemCodes.code });
    if (inserted.length !== rows.length) {
      console.error(`码值冲突：${rows.length - inserted.length} 个未生成，请重试`);
      process.exit(1);
    }

    console.log('批量发码完成');
    console.log(`批次号 batchId : ${batchId}`);
    console.log(`商品           : ${product.title}（${type}）`);
    console.log(`单价           : ${(product.priceMinor / 100).toFixed(2)} ${product.currency}`);
    console.log(`数量           : ${inserted.length}`);
    if (expiresAt) console.log(`有效期至       : ${expiresAt.toISOString()}`);
    console.log('--- 兑换码（只显示这一次，请立刻保存） ---');
    for (const row of inserted) console.log(row.code);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('发码失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
