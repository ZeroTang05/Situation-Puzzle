/** 验证弹窗决定的真实异步结果，取消操作不会误用空字符串作为确认。 */
import { describe, expect, it } from 'vitest';
import { DialogQueue } from '../../../packages/ui/src/dialog-queue.js';

describe('共用弹窗', () => {
  it('确认前保持等待，确认后只结束当前请求', async () => {
    const queue = new DialogQueue();
    let resolved = false;
    const result = queue.ask('confirm', '公布汤底？').then((value) => { resolved = true; return value; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(queue.current()?.message).toBe('公布汤底？');
    queue.settle('confirmed');
    expect(await result).toBe('confirmed');
    expect(queue.current()).toBeNull();
  });
  it('取消与空白输入分别返回 null 和空字符串', async () => {
    const queue = new DialogQueue();
    const cancelled = queue.ask('prompt', '处置原因');
    queue.settle(null);
    expect(await cancelled).toBeNull();
    const accepted = queue.ask('prompt', '处置原因');
    queue.settle('');
    expect(await accepted).toBe('');
  });
  it('多个请求按顺序处理，输入内容完整保留', async () => {
    const queue = new DialogQueue();
    const first = queue.ask('confirm', '结束？');
    const second = queue.ask('prompt', '原因');
    queue.settle(null);
    expect(await first).toBeNull();
    expect(queue.current()?.message).toBe('原因');
    queue.settle('重复发布 <内容>');
    expect(await second).toBe('重复发布 <内容>');
    queue.settle(null);
    expect(queue.current()).toBeNull();
  });
  it('订阅与取消订阅正确通知界面更新', async () => {
    const queue = new DialogQueue();
    let notifications = 0;
    const unsubscribe = queue.subscribe(() => { notifications += 1; });
    const pending = queue.ask('confirm', '确定？');
    expect(notifications).toBe(1);
    unsubscribe();
    queue.settle(null);
    await pending;
    expect(notifications).toBe(1);
  });
});
