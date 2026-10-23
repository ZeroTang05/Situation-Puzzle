/**
 * 社交域规则回归测试（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * 这几条口径决定了「谁能加谁、谁能私聊、谁看到未读」：
 *  - 申请-同意制：A→B 与 B→A 互斥，已是好友不能再申请
 *  - 只有收到申请的一方能处理它
 *  - 私聊只发生在好友之间
 *  - 已读水位只前进不后退
 */
import { describe, expect, it } from 'vitest';
import {
  QUICK_ROOM_CAPACITY,
  assertCanMessage,
  displayNickname,
  friendRequestBlockError,
  friendRequestBlockReason,
  friendResponseBlockError,
  friendResponseBlockReason,
  nextReadSeq,
  normalizeUserPair,
  unreadMessageCount,
} from './social.js';

describe('用户对规范化', () => {
  it('字典序小的在前，与数据库唯一索引口径一致', () => {
    expect(normalizeUserPair('bob', 'alice')).toEqual({ userLow: 'alice', userHigh: 'bob' });
    expect(normalizeUserPair('alice', 'bob')).toEqual({ userLow: 'alice', userHigh: 'bob' });
  });

  it('同一对用户无论谁先发起都落到同一对', () => {
    expect(normalizeUserPair('a', 'b')).toEqual(normalizeUserPair('b', 'a'));
  });
});

describe('发送好友申请', () => {
  it('没有关系的两个人可以发申请', () => {
    expect(
      friendRequestBlockReason({ selfId: 'a', targetId: 'b', isFriend: false, pendingRequesterUserId: null }),
    ).toBeNull();
  });

  it('不能加自己', () => {
    expect(
      friendRequestBlockReason({ selfId: 'a', targetId: 'a', isFriend: false, pendingRequesterUserId: null }),
    ).toBe('self');
  });

  it('已经是好友不能再申请', () => {
    expect(
      friendRequestBlockReason({ selfId: 'a', targetId: 'b', isFriend: true, pendingRequesterUserId: null }),
    ).toBe('already_friends');
  });

  it('自己发过申请时不能重复发', () => {
    expect(
      friendRequestBlockReason({ selfId: 'a', targetId: 'b', isFriend: false, pendingRequesterUserId: 'a' }),
    ).toBe('pending_outgoing');
  });

  it('对方发过申请时不能反向再发（避免两条申请顶掉）', () => {
    expect(
      friendRequestBlockReason({ selfId: 'a', targetId: 'b', isFriend: false, pendingRequesterUserId: 'b' }),
    ).toBe('pending_incoming');
  });

  it('拒绝原因映射到稳定错误码', () => {
    expect(friendRequestBlockError('self').code).toBe('FORBIDDEN');
    expect(friendRequestBlockError('already_friends').code).toBe('ALREADY_FRIENDS');
    expect(friendRequestBlockError('pending_outgoing').code).toBe('FRIEND_REQUEST_EXISTS');
    expect(friendRequestBlockError('pending_incoming').code).toBe('FRIEND_REQUEST_EXISTS');
  });
});

describe('处理好友申请', () => {
  it('收到申请的一方可以处理', () => {
    expect(friendResponseBlockReason({ responderId: 'b', targetUserId: 'b', status: 'pending' })).toBeNull();
  });

  it('发起人自己不能处理自己的申请', () => {
    expect(friendResponseBlockReason({ responderId: 'a', targetUserId: 'b', status: 'pending' })).toBe('not_target');
  });

  it('无关的第三方不能处理别人的申请', () => {
    expect(friendResponseBlockReason({ responderId: 'c', targetUserId: 'b', status: 'pending' })).toBe('not_target');
  });

  it('已经处理过的申请不能重复处理', () => {
    expect(friendResponseBlockReason({ responderId: 'b', targetUserId: 'b', status: 'accepted' })).toBe('already_handled');
  });

  it('拒绝原因映射到稳定错误码', () => {
    expect(friendResponseBlockError('not_target').code).toBe('FORBIDDEN');
    expect(friendResponseBlockError('already_handled').code).toBe('STATE_CONFLICT');
  });
});

describe('私聊权限', () => {
  it('好友之间可以私聊', () => {
    expect(() => assertCanMessage({ senderId: 'a', peerId: 'b', isFriend: true })).not.toThrow();
  });

  it('不是好友不能私聊', () => {
    expect(() => assertCanMessage({ senderId: 'a', peerId: 'b', isFriend: false })).toThrowError(/好友/);
  });

  it('不能给自己发消息', () => {
    expect(() => assertCanMessage({ senderId: 'a', peerId: 'a', isFriend: true })).toThrowError(/自己/);
  });
});

describe('已读水位', () => {
  it('水位只前进不后退', () => {
    expect(nextReadSeq(5, 9)).toBe(9);
    expect(nextReadSeq(9, 5)).toBe(9);
    expect(nextReadSeq(0, 0)).toBe(0);
  });

  it('未读数 = 序号大于水位的消息条数', () => {
    const messages = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }];
    expect(unreadMessageCount({ messages, lastReadSeq: 0 })).toBe(4);
    expect(unreadMessageCount({ messages, lastReadSeq: 2 })).toBe(2);
    expect(unreadMessageCount({ messages, lastReadSeq: 4 })).toBe(0);
  });

  it('水位超过最新序号时未读数为 0（不出现负数）', () => {
    expect(unreadMessageCount({ messages: [{ seq: 1 }], lastReadSeq: 9 })).toBe(0);
  });
});

describe('快捷开局', () => {
  it('容量固定为两人（发起方 + 好友）', () => {
    expect(QUICK_ROOM_CAPACITY).toBe(2);
  });
});

describe('昵称回退', () => {
  it('没有昵称时退回用户 id 前 8 位', () => {
    expect(displayNickname(null, 'abcdefghijklmnop')).toBe('abcdefgh');
    expect(displayNickname('   ', 'abcdefghijklmnop')).toBe('abcdefgh');
    expect(displayNickname('小明', 'abcdefghijklmnop')).toBe('小明');
  });
});
