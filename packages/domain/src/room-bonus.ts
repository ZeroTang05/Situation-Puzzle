/**
 * 奖励额度规则（docs/rebuild/21-MONETIZATION-REVISION.md）：
 * 看激励视频广告 / 邀请好友注册，发的开房次数直接加进免费池（freeRoomAccounts.total）。
 * 常量与判定收在纯函数，api / 后台 / 文档共用一套口径。
 */

/** 看完一次激励视频广告，增加的开房次数 */
export const AD_REWARD_ROOMS = 2;

/** 邀请一位好友注册，邀请人增加的开房次数 */
export const INVITE_REWARD_ROOMS = 5;

/** 一道投稿作品通过人工审核发布，作者增加的开房次数 */
export const CREATION_REWARD_ROOMS = 10;

/** 单用户每日广告奖励次数上限（防脚本刷广告） */
export const DAILY_AD_BONUS_LIMIT = 10;

/** 单用户每日邀请奖励次数上限（防批量注册互刷） */
export const DAILY_INVITE_BONUS_LIMIT = 10;

/**
 * 邀请码字符集：去掉 0/O/1/I/L 等易混字符的 31 字符表（不含元音，
 * 拼不出常见英文单词，避免生成歧义词）。
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const INVITE_CODE_LENGTH = 8;

/** 邀请码校验正则：与字符集同步，HTTP 契约层用来校验 claim 请求体 */
export const INVITE_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

/** 生成 8 位邀请码；随机源由调用方注入便于测试。 */
export function generateInviteCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 东八区偏移（毫秒）：奖励日额度与限流窗口用同一自然日口径 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 东八区自然日的零点（转成 UTC 时刻返回）。
 * 奖励日上限按这个边界计数：与限流「日窗口」（apps/api rate-limit.ts）对齐，
 * 玩家在同一个「今天」里看到的两套限额不会错位。
 */
export function shanghaiDayStart(now: Date = new Date()): Date {
  const local = now.getTime() + SHANGHAI_OFFSET_MS;
  return new Date(Math.floor(local / 86_400_000) * 86_400_000 - SHANGHAI_OFFSET_MS);
}
