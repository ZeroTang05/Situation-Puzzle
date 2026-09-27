/**
 * 题目投票与署名端到端验证（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §7 U01-U05）。
 * 真实进程 + 真实数据库 + 真实 SMTP 登录；不调用 Jev。
 *
 *   用户 A / B：登录 → 赞→重复赞→切换踩→取消（重复取消一致）→ 未登录 401 → 作者自投 403
 *   匿名署名：社区题默认匿名 → 作者申请署名（待审）→ admin 批准 → 公开展示署名；改回匿名立即生效
 *   排序：SQL 种投票后验证 popular 排序规则（得分降序、同分赞数降序）与 latest 不受影响
 * 运行：cd apps/api && node ../../scripts/e2e-votes.mjs（需要 e2e-run.sh votes 环境）
 */
import { requireFromApi, BASE, check, summary, http, dataOf, errorOf, login } from './e2e-lib.mjs';

const pg = requireFromApi('pg');
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://jev:jev@localhost:54329/jev';
const pool = new pg.Pool({ connectionString: DB_URL });
async function query(text, values) {
  const result = await pool.query(text, values);
  return result.rows;
}

const AUTHOR = `author-${Date.now()}@e2e.test`;
const VOTER = `voter-${Date.now()}@e2e.test`;
const ADMIN = `admin-${Date.now()}@e2e.test`;

console.log('== 1. 三账号登录（真实 SMTP 收信台）==');
const authorCookie = await login(AUTHOR);
const voterCookie = await login(VOTER);
const adminCookie = await login(ADMIN);
check('作者/投票者/管理员登录成功', authorCookie.length > 0 && voterCookie.length > 0 && adminCookie.length > 0);
const authorMe = dataOf(await http('/me', { cookie: authorCookie }));
const adminMe = dataOf(await http('/me', { cookie: adminCookie }));

console.log('== 2. 种一棵社区题（作者=作者账号，已发布，默认匿名）==');
const inserted = await query(
  `insert into puzzles (author_user_id, source, author_display_mode)
   values ($1, 'community', 'anonymous') returning id`,
  [authorMe.userId],
);
const puzzleId = inserted[0].id;
const versionId = (await query(
  `insert into puzzle_versions (puzzle_id, version_no, language, title, surface, answer, hints, core_facts, moderation_status)
   values ($1, 1, 'zh', '署名测试汤', '一碗只给审查用的汤面。', '审查用汤底。', '[]'::jsonb, '[]'::jsonb, 'published') returning id`,
  [puzzleId],
))[0].id;
await query(`update puzzles set current_published_version_id = $1 where id = $2`, [versionId, puzzleId]);
await query(`insert into puzzle_rights (puzzle_id, status, license_basis, agreement_version, agreed_at) values ($1, 'approved', 'e2e', 'ugc-license-v1', now())`, [puzzleId]);
check('社区题已发布', true);

console.log('== 3. 公开数据：匿名投影不含作者身份 ==');
const detail = dataOf(await http(`/puzzles/${puzzleId}`));
check('详情 authorDisplay 为匿名（name=null）', detail.authorDisplay.mode === 'anonymous' && detail.authorDisplay.name === null, JSON.stringify(detail.authorDisplay));
check('公开响应无 authorUserId 字段', !('authorUserId' in detail));
check('零票显示 0', detail.upCount === 0 && detail.downCount === 0, JSON.stringify(detail));

console.log('== 4. 投票：设置、重复、切换、取消 ==');
const unauthPut = await http(`/ratings/${puzzleId}`, { method: 'PUT', body: { value: 'up' } });
check('未登录投票 401', unauthPut.status === 401, `status=${unauthPut.status}`);

const put1 = await http(`/ratings/${puzzleId}`, { method: 'PUT', cookie: voterCookie, body: { value: 'up' } });
check('设置赞', put1.status === 200 && dataOf(put1).choice === 'up' && dataOf(put1).upCount === 1, JSON.stringify(put1.body));
const put2 = await http(`/ratings/${puzzleId}`, { method: 'PUT', cookie: voterCookie, body: { value: 'up' } });
check('同值重试不累加', dataOf(put2).upCount === 1 && dataOf(put2).downCount === 0, JSON.stringify(put2.body));
const switchDown = await http(`/ratings/${puzzleId}`, { method: 'PUT', cookie: voterCookie, body: { value: 'down' } });
check('切换为踩（不新增行）', switchDown.status === 200 && dataOf(switchDown).choice === 'down' && dataOf(switchDown).upCount === 0 && dataOf(switchDown).downCount === 1, JSON.stringify(switchDown.body));
const cancel = await http(`/ratings/${puzzleId}`, { method: 'DELETE', cookie: voterCookie });
check('取消投票', cancel.status === 200 && dataOf(cancel).choice === null && dataOf(cancel).downCount === 0, JSON.stringify(cancel.body));
const cancelAgain = await http(`/ratings/${puzzleId}`, { method: 'DELETE', cookie: voterCookie });
check('重复取消结果一致', cancelAgain.status === 200 && dataOf(cancelAgain).choice === null);

const myGet = await http(`/ratings/${puzzleId}`, { cookie: voterCookie });
check('本人查询返回选择与统计', myGet.status === 200 && dataOf(myGet).choice === null, JSON.stringify(myGet.body));

console.log('== 5. 作者自投拒绝（匿名作者按内部归属）==');
const selfVote = await http(`/ratings/${puzzleId}`, { method: 'PUT', cookie: authorCookie, body: { value: 'up' } });
check('作者自投 403', selfVote.status === 403 && errorOf(selfVote).code === 'FORBIDDEN', JSON.stringify(errorOf(selfVote)));

console.log('== 6. 署名审核全流程 ==');
const applySign = await http(`/creations/${puzzleId}/author-display`, { method: 'PATCH', cookie: authorCookie, body: { mode: 'signature', name: '  汤作者阿汤  ' } });
check('作者申请署名进入待审（公开仍匿名）', applySign.status === 200 && dataOf(applySign).pendingName === '汤作者阿汤' && dataOf(applySign).mode === 'anonymous', JSON.stringify(applySign.body));
const detailPending = dataOf(await http(`/puzzles/${puzzleId}`));
check('待审期间公开保持匿名', detailPending.authorDisplay.mode === 'anonymous' && detailPending.authorDisplay.name === null);

// 管理员角色：直接授予（与首个管理员初始化路径一致）
await query(`insert into role_assignments (user_id, role) values ($1, 'admin') on conflict (user_id) do update set role = 'admin'`, [adminMe.userId]);
const approveSign = await http(`/admin/puzzles/${puzzleId}/author-display/approve`, { method: 'POST', cookie: adminCookie, body: { reason: 'e2e 署名审核' } });
check('管理员批准署名', approveSign.status === 200 || approveSign.status === 201, JSON.stringify(approveSign.body));
const detailSigned = dataOf(await http(`/puzzles/${puzzleId}`));
check('批准后公开显示署名', detailSigned.authorDisplay.mode === 'signature' && detailSigned.authorDisplay.name === '汤作者阿汤', JSON.stringify(detailSigned.authorDisplay));
check('署名公开后仍无内部归属', !('authorUserId' in detailSigned));

const toAnonymous = await http(`/creations/${puzzleId}/author-display`, { method: 'PATCH', cookie: authorCookie, body: { mode: 'anonymous' } });
check('改回匿名立即生效', toAnonymous.status === 200 && dataOf(toAnonymous).mode === 'anonymous');
const detailAnon = dataOf(await http(`/puzzles/${puzzleId}`));
check('匿名后公开不再显示署名', detailAnon.authorDisplay.mode === 'anonymous' && detailAnon.authorDisplay.name === null);

console.log('== 7. 受欢迎排序规则 ==');
// SQL 种投票构造确定性得分：P1 得分 2（3 赞 1 踩）、P2 得分 2（2 赞 0 踩）、P3 得分 0
// 需要额外投票账号：直接种投票行（账号唯一约束按 user_id，种 4 个虚拟账号）
const voterIds = [];
for (let i = 0; i < 4; i++) {
  const id = `votebot-${Date.now()}-${i}`;
  await query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now()) on conflict (id) do nothing`,
    [id, `bot${i}`, `${id}@e2e.test`],
  );
  voterIds.push(id);
}
const p2 = (await query(`insert into puzzles (source) values ('community') returning id`))[0].id;
const p2v = (await query(
  `insert into puzzle_versions (puzzle_id, version_no, language, title, surface, answer, hints, core_facts, moderation_status)
   values ($1, 1, 'zh', '排序测试汤B', 'B 汤面', 'B 汤底', '[]'::jsonb, '[]'::jsonb, 'published') returning id`,
  [p2],
))[0].id;
await query(`update puzzles set current_published_version_id = $1 where id = $2`, [p2v, p2]);
// P1（本脚本社区题）：3 赞 1 踩 → 得分 2；P2：2 赞 → 得分 2（赞数少，排后）
await query(`insert into ratings (user_id, puzzle_id, value) values ($1,$2,'up'),($3,$2,'up')`, [voterIds[0], puzzleId, voterIds[1]]);
await query(`insert into ratings (user_id, puzzle_id, value) values ($1,$2,'up'),($3,$2,'down')`, [voterIds[2], puzzleId, voterIds[3]]);
await query(`insert into ratings (user_id, puzzle_id, value) values ($1,$2,'up'),($3,$2,'up')`, [voterIds[0], p2, voterIds[1]]);

const popular = dataOf(await http('/puzzles?language=zh&limit=50&sort=popular'));
const popularIds = popular.items.map((p) => p.id);
const i1 = popularIds.indexOf(puzzleId);
const i2 = popularIds.indexOf(p2);
check('popular：得分相同按赞数降序（P1 在 P2 前）', i1 >= 0 && i2 >= 0 && i1 < i2, `i1=${i1} i2=${i2}`);
check('popular：计数随行返回', popular.items[i1].upCount === 3 && popular.items[i1].downCount === 1, JSON.stringify({ up: popular.items[i1].upCount, down: popular.items[i1].downCount }));
const latest = dataOf(await http('/puzzles?language=zh&limit=50&sort=latest'));
check('latest 排序不受投票影响（最新在前）', latest.items[0].id === p2, `first=${latest.items[0].id} p2=${p2}`);
// 游标翻页：popular 第二页不重复
const page1 = dataOf(await http('/puzzles?language=zh&limit=2&sort=popular'));
const page2 = dataOf(await http(`/puzzles?language=zh&limit=2&sort=popular&cursor=${encodeURIComponent(page1.nextCursor)}`));
const dup = page2.items.filter((p) => page1.items.some((q) => q.id === p.id));
check('popular 游标翻页不重复（按作品 ID 去重前提）', page1.items.length === 2 && dup.length === 0, JSON.stringify(dup.map((d) => d.id)));

console.log('== 8. 单人业务表零写入确认 ==');
// 投票不允许创建任何单人会话/对话（单人对话只存浏览器）
const soloTables = await query(
  `select (select count(*)::int from information_schema.tables where table_schema='public' and table_name like 'solo%') as solo_tables`,
);
check('服务端无单人业务表', soloTables[0].solo_tables === 0);

await pool.end();
summary();
