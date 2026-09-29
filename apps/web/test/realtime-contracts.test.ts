/** 验证本次新增的确认协议与浏览器活动帧。 */
import { describe, expect, it } from 'vitest';
import { roomCommandLookupSchema, roomCommandResponseSchema, wsClientFrameSchema } from '@jev/contracts';

const requestId = 'b8550f12-ffce-4986-a61e-65235424cdb9';
describe('可靠通信契约', () => {
  it('受理结果必须携带原请求编号', () => {
    expect(roomCommandResponseSchema.safeParse({ status: 'accepted', controlVersion: 1 }).success).toBe(false);
    expect(roomCommandResponseSchema.parse({ clientRequestId: requestId, status: 'accepted', controlVersion: 1 }).clientRequestId).toBe(requestId);
  });
  it('已找到的命令必须包含保存结果', () => {
    expect(roomCommandLookupSchema.safeParse({ status: 'accepted' }).success).toBe(false);
    expect(roomCommandLookupSchema.parse({ status: 'accepted', result: { clientRequestId: requestId, status: 'duplicate', controlVersion: 2 } }).status).toBe('accepted');
  });
  it('未知结果有独立状态，不会表示成保存成功', () => {
    expect(roomCommandLookupSchema.parse({ status: 'not_found' })).toEqual({ status: 'not_found' });
  });
  it('前台与后台活动可以区分', () => {
    expect(wsClientFrameSchema.parse({ type: 'ping', visible: false })).toEqual({ type: 'ping', visible: false });
    expect(wsClientFrameSchema.parse({ type: 'ping', visible: true })).toEqual({ type: 'ping', visible: true });
  });
  it('补齐游标必须是非负整数', () => {
    for (const lastSeq of [-1, 1.5]) expect(wsClientFrameSchema.safeParse({ type: 'subscribe', roomId: 'room', lastSeq }).success).toBe(false);
    expect(wsClientFrameSchema.parse({ type: 'subscribe', roomId: 'room', lastSeq: 0 })).toMatchObject({ lastSeq: 0 });
  });
});
